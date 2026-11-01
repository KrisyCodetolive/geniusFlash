# GeniusSend

GeniusSend est une application de transfert de fichiers conçue pour échanger des fichiers directement entre appareils sur un réseau local.

## Architecture

- Serveur de signalisation : échanges de négociation via WebSocket
- Transfert direct : canal de données WebRTC (DataChannel)
- Taille maximale acceptée : 10 Go. Le navigateur charge actuellement le fichier complet en mémoire ; les transferts proches de cette limite peuvent dépasser la mémoire disponible.
- Liste des appareils : affiche les appareils actuellement connectés à GeniusSend ; les appareils déconnectés du site sont masqués.
- Interface : application web exécutée dans le navigateur

Par défaut, le serveur enregistre les appareils dans SQLite, dans `apps/server/data/geniussend.sqlite`. Définissez `GENIUSSEND_DB_PATH` pour placer la base de données dans un répertoire persistant de l’hôte. Le serveur nécessite Node.js 22.13 ou une version ultérieure.

### QR code et adresse de partage

Le QR code de l’application encode par défaut l’adresse ouverte dans le navigateur. Si le site est ouvert par un nom de domaine que les téléphones ne savent pas résoudre (par exemple un nom ajouté dans le fichier `hosts` par GeniusDNS), définissez `GENIUSSEND_SHARE_URL` sur le serveur (ex. `http://192.168.1.20`) : le QR code et le lien affichés pointeront alors vers cette adresse. Le serveur l’expose sur `/share-url` ; si la variable est vide, l’adresse du navigateur est conservée. Avec Docker Compose, la variable est transmise depuis l’environnement ou un fichier `.env`.

### Chat en direct

Tous les appareils connectés partagent un salon de discussion unique. Contrairement aux transferts directs (qui passent d’un appareil à l’autre sans jamais être stockés), les messages et les fichiers du chat transitent par le serveur afin d’être visibles par tous, y compris par les appareils qui arrivent plus tard :

- les messages et les fichiers sont conservés **24 heures**, puis supprimés automatiquement ;
- à l’arrivée, un appareil reçoit les **200 derniers messages** ;
- un fichier du chat pèse au maximum **100 Mo** ; il est enregistré dans le dossier `chat-files`, à côté de la base SQLite (donc dans le volume `/data` en Docker).

### Demandes de transfert hors ligne et notifications Push

Une demande hors ligne ne stocke que les métadonnées du fichier sur le serveur. Le fichier lui-même reste dans l’onglet du navigateur de l’expéditeur. Celui-ci doit garder GeniusSend ouvert et connecté jusqu’à l’acceptation du destinataire. Si la page est fermée ou si sa connexion au serveur est perdue, la demande est annulée. Après acceptation, les appareils établissent une connexion WebRTC et le transfert du fichier commence.

Les notifications Push sont facultatives. Pour les activer, configurez `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT` sur le serveur de signalisation, puis ouvrez le profil de l’appareil dans GeniusSend et activez explicitement les notifications. Générez une paire de clés avec `npx web-push generate-vapid-keys`.

Le site doit être servi en HTTPS (sauf `localhost` en développement). Sur iPhone et iPad, les notifications Web Push nécessitent que l’application web soit installée. Pour recevoir une notification, l’appareil doit avoir ouvert GeniusSend, autorisé les notifications et créé un abonnement Push. Une notification ne peut pas atteindre un appareil éteint ou sans connexion réseau. Si VAPID n’est pas configuré, les demandes en attente seront transmises à la reconnexion du destinataire, mais aucune notification Push ne sera envoyée.

## Structure du projet

- `apps/server` : serveur de signalisation
- `apps/web` : application web
- `genius-dns` : registre de noms local signé et agent qui l’écrit dans le fichier `hosts` (Python, voir [genius-dns/README.md](genius-dns/README.md))

## Commandes

```bash
npm install
npm run dev:server
npm run dev:web
```

## Déploiement avec Docker

```bash
GENIUSSEND_SHARE_URL=http://192.168.1.20 docker compose up -d --build
```

Le service `web` (nginx) relaie `/socket.io`, `/chat` et `/share-url` vers le service `server`, qui reste interne. Les données (SQLite, fichiers du chat) sont dans le volume `geniussend-data`. Le fichier `docker-compose.yaml` n’expose pas de port sur l’hôte : ajoutez une publication de port pour `web` (ou un reverse proxy) selon votre installation.

## GeniusDNS : accéder à l’application par un nom

Sur un réseau local sans configuration du routeur, GeniusDNS permet d’ouvrir GeniusSend (et toute autre application locale) par un nom de domaine :

- un **registre** (sur le mini PC) tient la liste `nom → IP privée` et la sert signée (Ed25519) ;
- un **agent** (sur chaque PC, exécutable Linux fourni) la récupère et l’écrit dans un bloc balisé du fichier `hosts`, uniquement pour les suffixes autorisés et vers des adresses privées.

Les téléphones ne modifient pas `hosts` : le QR code utilise l’adresse IP (`GENIUSSEND_SHARE_URL`). Le site est servi en HTTP simple pour l’instant (pas de HTTPS ni de PWA installable sur ce chemin). Installation, administration à distance (`gdns`) et build de l’exécutable : [genius-dns/README.md](genius-dns/README.md).
