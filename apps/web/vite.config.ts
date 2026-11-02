import { resolve } from 'node:path';
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
  // Deux pages : l’accueil qui présente GeniusSend (/) et l’application elle-même (/app/).
  build: {
    rollupOptions: {
      input: {
        accueil: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app/index.html')
      }
    }
  },
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
