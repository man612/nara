import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import type { DeviceCommand, DeviceEvent } from "./contracts/device.js";

const port = Number(process.env.PORT ?? 8787);
const virtualDeviceHtml = resolve(process.cwd(), "virtual-device", "index.html");

const server = createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/virtual-device") {
    const html = await readFile(virtualDeviceHtml, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "nara" }));
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/device" });

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "gateway.ready", version: 1 }));

  socket.on("message", (raw) => {
    const event = JSON.parse(raw.toString()) as DeviceEvent;
    console.log("[device]", event);

    if (event.type === "hello") {
      const command: DeviceCommand = {
        type: "face.set",
        emotion: "happy",
        intensity: 0.6,
        durationMs: 1200
      };
      socket.send(JSON.stringify(command));
    }

    if (event.type === "speech.stopped") {
      socket.send(JSON.stringify({ type: "face.set", emotion: "thinking", intensity: 0.8 }));
    }
  });
});

server.listen(port, () => {
  console.log(`Companion gateway: http://localhost:${port}`);
  console.log(`Virtual device:   http://localhost:${port}/virtual-device`);
});
