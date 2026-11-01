# GeniusDNS

Registre de noms local et agent qui le synchronise dans le fichier `hosts`, pour que les applications
locales soient accessibles par leur nom de domaine sans configurer le routeur.

- **registry** (mini PC) : tient la liste `nom → IP privée`, la sert signée (Ed25519) sur `/v1/registry`.
- **agent** (chaque PC) : interroge le registre, vérifie la signature, écrit un bloc balisé dans `hosts`.

## Garde-fous de l'agent

- signature Ed25519 vérifiée avec la clé publique fournie à l'installation ;
- seuls les noms sous les suffixes autorisés (`--suffix`) sont écrits, et uniquement vers des IP privées ;
- refus d'un `serial` plus ancien que le dernier vu (pas de retour en arrière) ;
- registre injoignable au-delà de `--grace` secondes : le bloc est retiré (changement de réseau probable) ;
- seul le bloc `# BEGIN/END GENIUSDNS` est modifié, écriture atomique, sauvegarde `hosts.geniusdns.bak`.

## Utilisation

```bash
cd genius-dns
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'   # une fois ; commandes dans .venv/bin
```

### Registre (mini PC)

```bash
gdns keygen                 # registry.key (SECRÈTE) + registry.pub (à distribuer aux agents)
gdns token                  # registry.token : jeton d'administration à distance
gdns add send.genius.ln 172.20.10.2
gdns list
gdns serve --port 5353      # sert aussi les exécutables du dossier dist/ sur /download/
```

`gdns` est un alias de `geniusdns-registry` (dans `.venv/bin`). Ne commitez jamais `registry.key` ni
`registry.token` (ils sont dans `.gitignore`).

### CLI à distance

Avec `--server`, les commandes passent par le serveur en cours d'exécution, depuis n'importe quelle
machine qui a le jeton (copie de `registry.token`, ou variable `GENIUSDNS_TOKEN`) :

```bash
export GENIUSDNS_SERVER=http://172.20.10.2:5353
gdns list
gdns add crm.genius.ln 172.20.10.2
gdns remove crm.genius.ln
```

Le jeton circule en clair en HTTP : à réserver au réseau de confiance.

### Agent (chaque PC)

```bash
# Exécutable Linux téléchargé depuis le registre
curl -O http://172.20.10.2:5353/download/geniusdns-agent-linux-x86_64
curl -O http://172.20.10.2:5353/download/geniusdns-agent-linux-x86_64.sha256 && sha256sum -c *.sha256
chmod +x geniusdns-agent-linux-x86_64

sudo ./geniusdns-agent-linux-x86_64 \
  --registry-url http://172.20.10.2:5353/v1/registry \
  --public-key registry.pub --suffix genius.ln run
```

La dernière commande peut être `run` (en continu), `sync` (une fois), `status` ou `clean`
(retire le bloc de hosts). Sans exécutable : `sudo .venv/bin/geniusdns-agent ...`.
Pour essayer sans droits admin : `--hosts-file /tmp/hosts --state-file /tmp/state.json`.

### Construire l'exécutable Linux

```bash
.venv/bin/pip install pyinstaller
./scripts/build-linux.sh        # -> dist/geniusdns-agent-linux-x86_64 (+ .sha256)
```

L'exécutable embarque Python mais dépend de la glibc de la machine de build : il fonctionne sur les
distributions aussi récentes ou plus récentes.

## Tests

```bash
.venv/bin/python -m pytest
```
