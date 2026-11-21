// Stands in for an `expo export` that never ends: it sends its PID and output dir as one JSON line to the loopback port
// in argv[2], then answers every line it is sent until it is killed.
import { connect } from "node:net";

const [port = "", ...args] = process.argv.slice(2);
const out = args[args.indexOf("--output-dir") + 1];
const socket = connect(Number(port), "127.0.0.1", () => {
  socket.write(`${JSON.stringify({ pid: process.pid, out })}\n`);
});
socket.on("data", () => socket.write("here\n"));
