import { startServer } from "./server.js";

startServer().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
