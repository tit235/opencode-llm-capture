import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PORT = 3000;
const LOG_DIR = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode-llm-capture');
const VIEWER_PATH = path.join(__dirname, 'viewer.html');

// Helper for CORS and JSON headers
const sendJSON = (res: http.ServerResponse, data: any) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
};

const sendError = (res: http.ServerResponse, status: number, message: string) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ error: message }));
};

const server = http.createServer(async (req, res) => {
  // Enable CORS for development flexibility
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  console.log(`${req.method} ${pathname}`);

  // Route: Serve viewer.html
  if (pathname === '/') {
    try {
      // Read viewer.html from same directory
      const htmlPath = path.join(__dirname, 'viewer.html');

      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else {
        sendError(res, 404, 'viewer.html not found');
      }
    } catch (e) {
      sendError(res, 500, 'Error reading viewer.html');
    }
    return;
  }

  // Route: List all sessions (folders in LOG_DIR)
  if (pathname === '/api/sessions') {
    try {
      if (!fs.existsSync(LOG_DIR)) {
        sendJSON(res, []);
        return;
      }

      const entries = fs.readdirSync(LOG_DIR, { withFileTypes: true });
      const sessions = [];

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('ses_')) {
          const sessionPath = path.join(LOG_DIR, entry.name);
          const files = fs.readdirSync(sessionPath).filter((f) => f.endsWith('.json') && !f.startsWith('latest'));

          // Basic stats
          let timestamps: number[] = [];
          // Read a few files to get timestamps (optimization: just read stats or a few files)
          // For performance, we'll just check modification time of the folder or first file
          // But to be consistent with client-side logic, we might need to peek at files.
          // Let's do a lightweight scan: just file count and directory mtime
          const stats = fs.statSync(sessionPath);

          sessions.push({
            name: entry.name,
            count: files.length,
            mtime: stats.mtime.getTime(),
          });
        }
      }

      // Sort by recent
      sessions.sort((a, b) => b.mtime - a.mtime);
      sendJSON(res, sessions);
    } catch (e) {
      console.error(e);
      sendError(res, 500, 'Failed to list sessions');
    }
    return;
  }

  // Route: Get files for a session
  if (pathname.startsWith('/api/session/')) {
    const sessionId = pathname.split('/').pop();
    if (!sessionId) {
      sendError(res, 400, 'Missing session ID');
      return;
    }

    const sessionPath = path.join(LOG_DIR, sessionId);

    if (!sessionPath.startsWith(LOG_DIR)) {
      sendError(res, 403, 'Access denied');
      return;
    }

    try {
      if (!fs.existsSync(sessionPath)) {
        sendError(res, 404, 'Session not found');
        return;
      }

      const files = fs.readdirSync(sessionPath).filter((f) => f.endsWith('.json') && !f.startsWith('latest'));

      const fileData = [];
      for (const file of files) {
        const filePath = path.join(sessionPath, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const json = JSON.parse(content);

          if (!json?.metadata || !json?.request || !json?.response) {
            console.warn('[viewer] Invalid log structure', {
              file,
              filePath,
              hasMetadata: Boolean(json?.metadata),
              hasRequest: Boolean(json?.request),
              hasResponse: Boolean(json?.response),
            });
            continue;
          }

          fileData.push({
            name: file,
            data: json,
          });
        } catch (e) {
          console.warn('[viewer] Failed to read/parse log', {
            file,
            filePath,
            error: String(e),
          });
        }
      }

      sendJSON(res, fileData);
    } catch (e) {
      console.error(e);
      sendError(res, 500, 'Failed to read session files');
    }
    return;
  }

  sendError(res, 404, 'Not found');
});

server.listen(PORT, () => {
  console.log(`OpenCode LLM Viewer running at http://localhost:${PORT}`);
  console.log(`Watching logs at: ${LOG_DIR}`);
});
