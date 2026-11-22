#!/usr/bin/env python3
"""Small static web server for trying the player on your own computer.

Python's built-in `http.server` cannot answer HTTP Range requests, which the player needs to read the big installer (.exe) and
.zip files in pieces, in place. This one can. Put the game's files in the `game/` folder next to index.html, together with a
`files.json` that lists their names (see README.md), or use the "Use my own files" button on the page.

    python3 serve.py            # then open http://localhost:8000/
    python3 serve.py 8080       # another port
    python3 serve.py --bind 0.0.0.0 8000   # reachable from other devices on your network

For real hosting use any normal web server (nginx, Apache, Caddy, S3 ...): they all support Range requests.
"""
import argparse
import http.server
import io
import json
import os
import re
import socketserver
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
    extensions_map.update({'.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '': 'application/octet-stream',
                           '.zip': 'application/zip', '.exe': 'application/octet-stream', '.ini': 'text/plain', '.txt': 'text/plain',
                           '.html': 'text/html', '.wasm': 'application/wasm'})
    verbose = False
    _remaining = None

    def log_message(self, fmt, *args):
        if self.verbose:
            super().log_message(fmt, *args)

    def end_headers(self):
        if self._remaining is None:
            self.send_header('Accept-Ranges', 'bytes')
        if self.path.split('?')[0].endswith(('.html', '.js', '.json', '/')):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def auto_file_list(self):
        """A folder without a files.json (game/): answer with the list of the .zip and .exe files that are in it."""
        url = self.path.split('?', 1)[0]
        if not url.endswith('/files.json'):
            return None
        path = self.translate_path(url)
        folder = os.path.dirname(path)
        if os.path.isfile(path) or not os.path.isdir(folder):
            return None
        names = sorted(n for n in os.listdir(folder) if n.lower().endswith(('.zip', '.exe')) and os.path.isfile(os.path.join(folder, n)))
        body = (json.dumps(names, indent=1) + '\n').encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        return io.BytesIO(body)

    def send_head(self):
        self._remaining = None
        auto = self.auto_file_list()
        if auto is not None:
            return auto
        rng = self.headers.get('Range')
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            return super().send_head()
        m = re.match(r'bytes=(\d*)-(\d*)$', rng.strip())
        if not m or (m.group(1) == '' and m.group(2) == ''):
            return super().send_head()
        size = os.path.getsize(path)
        a, b = m.groups()
        if a == '':
            start, end = max(0, size - int(b)), size - 1
        else:
            start, end = int(a), (int(b) if b else size - 1)
        if size == 0 or start >= size or start > end:
            self.send_response(416)
            self.send_header('Content-Range', 'bytes */%d' % size)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        end = min(end, size - 1)
        f = open(path, 'rb')
        f.seek(start)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Last-Modified', self.date_time_string(os.stat(path).st_mtime))
        self._remaining = end - start + 1
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):
        n = self._remaining
        if n is None:
            return super().copyfile(source, outputfile)
        while n > 0:
            buf = source.read(min(1 << 16, n))
            if not buf:
                break
            outputfile.write(buf)
            n -= len(buf)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):          # browsers drop connections all the time; stay quiet about it
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('port', nargs='?', type=int, default=8000)
    ap.add_argument('--bind', default='127.0.0.1', help='address to listen on (default 127.0.0.1, this computer only)')
    ap.add_argument('--verbose', action='store_true', help='log every request')
    a = ap.parse_args()
    Handler.verbose = a.verbose
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    srv = Server((a.bind, a.port), Handler)
    print('Serving %s on http://%s:%d/  (Ctrl+C to stop)' % (os.getcwd(), 'localhost' if a.bind in ('127.0.0.1', '0.0.0.0') else a.bind, a.port))
    game = os.path.join(os.getcwd(), 'game')
    if os.path.isdir(game):
        found = sorted(n for n in os.listdir(game) if n.lower().endswith(('.zip', '.exe')))
        listed = os.path.isfile(os.path.join(game, 'files.json'))
        print('game/ holds %d .zip / .exe file(s)%s' % (len(found), ' (files.json lists the ones to use)' if listed else ' (no files.json: all of them are used)'))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == '__main__':
    main()
