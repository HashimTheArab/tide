// Exits once it has started a worker in its own process group with stdio of its own. The worker sends its PID as one
// JSON line to the loopback port in argv[2], then answers every line it is sent until it is killed.
import { spawn } from "node:child_process";
import { connect } from "node:net";

const [port = "", role] = process.argv.slice(2);
if (role === "worker") {
  const socket = connect(Number(port), "127.0.0.1", () => {
    socket.write(`${JSON.stringify({ pid: process.pid })}\n`);
    process.stdout.write("ready\n");
  });
  socket.on("data", () => socket.write("here\n"));
} else {
  const worker = spawn(process.execPath, [process.argv[1] ?? "", port, "worker"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  worker.stdout.once("data", () => process.exit(0));
}
