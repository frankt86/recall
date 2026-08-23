import { openDb } from "../db";
import { startUi } from "../ui/server";
import { portOption, type CommandSpec } from "./args";

export const ui: CommandSpec<{ port?: string; open?: boolean }> = {
  name: "ui",
  summary: "local memory manager (web app), exits with the process",
  options: {
    port: { type: "string", help: "port (default: random free port)" },
    open: { type: "boolean", help: "open in the default browser" },
  },
  async run(o) {
    const port = portOption(o.port);
    const db = openDb();
    let srv: ReturnType<typeof startUi>;
    try {
      srv = startUi(db, port);
    } catch (e) {
      const msg = (e as Error).message;
      throw new Error(/EADDRINUSE|in use/i.test(msg) ? `port ${port} is already in use (omit --port for a free one)` : `cannot start viewer: ${msg}`);
    }
    const url = `http://127.0.0.1:${srv.port}/`;
    console.log(`viewer: ${url}  (ctrl-c to stop; nothing listens when this exits)`);
    if (o.open) {
      const cmd = process.platform === "win32" ? ["cmd", "/c", "start", "", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
      try {
        Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true }).unref();
      } catch {
        console.log("could not open browser automatically");
      }
    }
    const stop = () => {
      srv.stop();
      db.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  },
};
