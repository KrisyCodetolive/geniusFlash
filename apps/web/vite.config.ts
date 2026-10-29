import { defineConfig } from 'vite';

// Relaie le WebSocket et les fichiers du chat vers le serveur, comme nginx en production.
const signalingProxy = {
  '/socket.io': {
    target: 'http://localhost:3001',
    ws: true
  },
  '/chat': {
    target: 'http://localhost:3001'
  }
};

export default defineConfig({
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: signalingProxy
  },
  preview: {
    port: 4173,
    host: '0.0.0.0',
    proxy: signalingProxy
  }
});
