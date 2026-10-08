# GeniusSend

GeniusSend est une application de transfert de fichiers conçue pour échanger des fichiers directement entre appareils sur un réseau local.

## Architecture

- Serveur de signalisation : échanges de négociation via WebSocket
- Transfert direct : canal de données WebRTC (DataChannel)
- Taille maximale acceptée : 10 Go. Le navigateur charge actuellement le fichier complet en mémoire ; les transferts proches de cette limite peuvent dépasser la mémoire disponible.
- Liste des appareils : affiche les appareils actuellement connectés à GeniusSend ; les appareils déconnectés du site sont masqués.
- Interface : application web exécutée dans le navigateur

Par défaut, le serveur enregistre les appareils dans SQLite, dans `apps/server/data/geniussend.sqlite`. Définissez `GENIUSSEND_DB_PATH` pour placer la base de données dans un répertoire persistant de l’hôte. Le serveur nécessite Node.js 22.13 ou une version ultérieure.

### Demandes de transfert hors ligne et notifications Push

Une demande hors ligne ne stocke que les métadonnées du fichier sur le serveur. Le fichier lui-même reste dans l’onglet du navigateur de l’expéditeur. Celui-ci doit garder GeniusSend ouvert et connecté jusqu’à l’acceptation du destinataire. Si la page est fermée ou si sa connexion au serveur est perdue, la demande est annulée. Après acceptation, les appareils établissent une connexion WebRTC et le transfert du fichier commence.

Les notifications Push sont facultatives. Pour les activer, configurez `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT` sur le serveur de signalisation, puis ouvrez le profil de l’appareil dans GeniusSend et activez explicitement les notifications. Générez une paire de clés avec `npx web-push generate-vapid-keys`.

Le site doit être servi en HTTPS (sauf `localhost` en développement). Sur iPhone et iPad, les notifications Web Push nécessitent que l’application web soit installée. Pour recevoir une notification, l’appareil doit avoir ouvert GeniusSend, autorisé les notifications et créé un abonnement Push. Une notification ne peut pas atteindre un appareil éteint ou sans connexion réseau. Si VAPID n’est pas configuré, les demandes en attente seront transmises à la reconnexion du destinataire, mais aucune notification Push ne sera envoyée.

## Structure du projet

- `apps/server` : serveur de signalisation
- `apps/web` : application web

## Commandes

```bash
npm install
npm run dev:server
npm run dev:web
```
