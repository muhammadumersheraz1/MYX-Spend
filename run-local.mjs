import http from "http";
import app from "./src/express-app.js";

const START_PORT = Number(process.env.PORT) || 3000;
const MAX_PORT_TRIES = 50;

function listenFrom(port) {
  if (port > START_PORT + MAX_PORT_TRIES) {
    console.error(
      `No free port found between ${START_PORT} and ${START_PORT + MAX_PORT_TRIES}. Set PORT to a free port.`
    );
    process.exit(1);
  }

  const server = http.createServer(app);
  server.listen(port, () => {
    console.log(`MYXSpend API listening on http://localhost:${port}`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      server.close(() => {
        console.warn(`Port ${port} in use, trying ${port + 1}...`);
        listenFrom(port + 1);
      });
      return;
    }
    throw err;
  });
}

listenFrom(START_PORT);
