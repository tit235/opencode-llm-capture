import type { Plugin } from '@opencode-ai/plugin';
import { mkdir, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';

export default (async ({ directory }) => {
  const baseDir = join(homedir(), '.local', 'share', 'opencode', 'opencode-llm-capture');
  const ensureDir = async (d: string) => mkdir(d, { recursive: true }).catch(() => {});

  // Helper: session dir from sessionID or date fallback
  const getSessionDirFor = (sessionID?: string) => {
    if (sessionID && String(sessionID).trim()) {
      return join(baseDir, String(sessionID));
    }
    return join(baseDir, new Date().toISOString().split('T')[0]);
  };

  // safe write helper (确保父目录存在)
  const safeWrite = async (filepath: string, data: any) => {
    const d = dirname(filepath);
    await ensureDir(d);
    await writeFile(filepath, JSON.stringify(data, null, 2)).catch(() => {});
  };

  // 标记 plugin 已加载（按启动目录写到 baseDir/latest-plugin.json）
  await ensureDir(baseDir);
  await safeWrite(join(baseDir, 'latest-plugin.json'), {
    timestamp: new Date().toISOString(),
    directory,
  });

  // 把 global.fetch 包裹起来（仅包裹一次）
  const originalFetch = globalThis.fetch?.bind(globalThis);
  if (originalFetch && !(globalThis as any).__opencode_debug_fetch_wrapped) {
    (globalThis as any).__opencode_debug_fetch_wrapped = true;

    let counter = 0;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const shouldDump = process.env.OPENCODE_LLM_CAPTURE === 'true' || process.env.OPENCODE_LLM_CAPTURE === '1';
      if (!shouldDump) {
        return originalFetch(input, init);
      }

      counter++;
      // Snapshot URL & method safely
      let url: string;
      let method: string;
      if (typeof input === 'string') {
        url = input;
        method = init?.method ?? 'GET';
      } else if (input instanceof URL) {
        url = input.href;
        method = init?.method ?? 'GET';
      } else {
        url = (input as Request).url;
        method = (input as Request).method;
      }

      // Snapshot headers without mutating the original init
      const hdrs: Record<string, string> = {};
      try {
        const h = new Headers(init?.headers ?? (input instanceof Request ? (input as Request).headers : undefined));
        h.forEach((v, k) => (hdrs[k.toLowerCase()] = v));
      } catch {
        // ignore
      }

      // Try to find our debug session header (plugin 会在 chat.headers 中注入)
      // 使用小写键名比较稳定
      const debugSessionHeader =
        hdrs['x-opencode-debug-session'] ?? hdrs['x-opencode-session'] ?? hdrs['x-opencode-request'];

      // Determine session dir (prefer debugSessionHeader value)
      const sessionDir = getSessionDirFor(debugSessionHeader);

      // Only snapshot body when safe (avoid consuming stream)
      let requestBodySnapshot: unknown = null;
      if (init?.body && typeof init.body === 'string') {
        try {
          requestBodySnapshot = JSON.parse(init.body);
        } catch {
          requestBodySnapshot = init.body;
        }
      } else if (input instanceof Request) {
        // 标记但不消费请求流
        try {
          requestBodySnapshot = (input as any).body ? '(stream/unreadable body)' : null;
        } catch {
          requestBodySnapshot = null;
        }
      }

      // Perform the real fetch (preserve original init and headers)
      const start = Date.now();
      const resp = await originalFetch(input, init);
      const duration = Date.now() - start;

      // Clone response to read body safely
      let responseSnapshot: unknown = null;
      let responseType = 'unknown';
      try {
        const clone = resp.clone();
        const txt = await clone.text();
        if (!txt) {
          responseSnapshot = null;
          responseType = 'empty';
        } else if (txt.startsWith('data:') || txt.includes('\ndata:')) {
          const lines = txt.split('\n');
          responseSnapshot = {
            type: 'sse-stream',
            preview: lines,
            totalLines: lines.length,
            truncated: false,
          };
          responseType = 'stream';
        } else {
          try {
            responseSnapshot = JSON.parse(txt);
            responseType = 'json';
          } catch {
            responseSnapshot = txt.length > 5000 ? txt.slice(0, 5000) + '…(truncated)' : txt;
            responseType = 'text';
          }
        }
      } catch (err) {
        responseSnapshot = { readError: String(err) };
        responseType = 'error';
      }

      // Build log object and write to session-based folder
      const id = String(counter).padStart(4, '0');
      const timeStr = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '');
      const filename = `${id}-${resp.status}-${timeStr}.json`;
      const fullPath = join(sessionDir, filename);

      const logObj = {
        metadata: {
          id,
          timestamp: new Date().toISOString(),
          durationMs: duration,
          url,
          method,
          responseType,
        },
        request: { headers: hdrs, body: requestBodySnapshot },
        response: {
          status: resp.status,
          statusText: resp.statusText,
          headers: Object.fromEntries(resp.headers),
          body: responseSnapshot,
        },
      };

      await safeWrite(fullPath, logObj);
      await safeWrite(join(sessionDir, 'latest.json'), {
        latestFile: filename,
        timestamp: new Date().toISOString(),
        url,
        status: resp.status,
        durationMs: duration,
      });

      return resp;
    };
  }

  // Return hooks: 注入 chat.headers，让每次发给 provider 的请求带上 session id（不会影响授权）
  return {
    'chat.headers': async (input: { sessionID?: string }, output: { headers: Record<string, string> }) => {
      try {
        if (input?.sessionID) {
          // 不要覆盖已有 header，如果存在就保留
          if (!output.headers) output.headers = {};
          if (!output.headers['x-opencode-debug-session'] && !output.headers['X-Opencode-Debug-Session']) {
            output.headers['x-opencode-debug-session'] = String(input.sessionID);
          }
        }
      } catch {
        // 忽略错误，切勿阻塞 LLM 流程
      }
    },
  };
}) satisfies Plugin;
