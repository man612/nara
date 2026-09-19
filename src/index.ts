import "dotenv/config";
import { createGatewayServer } from "./gateway.js";

const port = Number(process.env.PORT ?? 8787);
const deviceToken = process.env.NARA_DEVICE_TOKEN;

const { server } = createGatewayServer({ deviceToken });

server.listen(port, () => {
  console.log(`Companion gateway: http://localhost:${port}`);
  console.log(`Virtual device:   http://localhost:${port}/virtual-device`);
  if (!deviceToken) {
    console.warn("NARA_DEVICE_TOKEN is not set; /device accepts unauthenticated clients");
  }
});
