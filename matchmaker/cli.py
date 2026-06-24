import socket
import threading
import webbrowser
import os
import sys


def find_free_port(start=5000, end=5010):
    for port in range(start, end):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port found in range {start}–{end}")


def main():
    # Resolve the data root: directory where the user launched matchmaker,
    # or the repo root when running with `python -m matchmaker`.
    data_root = os.environ.get("MATCHMAKER_ROOT", os.getcwd())

    port = int(os.environ["MATCHMAKER_PORT"]) if "MATCHMAKER_PORT" in os.environ else find_free_port()
    url = f"http://localhost:{port}"

    print(f"Match Maker {__import__('matchmaker').__version__}")
    print(f"Data root : {data_root}")
    print(f"Server    : {url}")
    print("Press Ctrl-C to stop.")

    from matchmaker.server import create_app
    app = create_app(data_root=data_root)

    # Open browser after a short delay so the server is ready
    def _open():
        import time
        time.sleep(0.8)
        webbrowser.open(url)

    threading.Thread(target=_open, daemon=True).start()

    try:
        app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()
