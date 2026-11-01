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
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'   # une fois ; les commandes sont dans .venv/bin

# Mini PC
.venv/bin/geniusdns-registry keygen              # registry.key (secrète) + registry.pub
.venv/bin/geniusdns-registry add send.genius.xyz 192.168.1.20
.venv/bin/geniusdns-registry list
.venv/bin/geniusdns-registry serve --port 5353

# PC client (sudo : écrit dans /etc/hosts ; on appelle le venv, que root peut exécuter)
# registry.pub = clé publique copiée depuis le mini PC
sudo .venv/bin/geniusdns-agent \
  --registry-url http://192.168.1.20:5353/v1/registry \
  --public-key registry.pub --suffix genius.xyz run
```

La dernière commande de la ligne peut être `run` (en continu), `sync` (une fois), `status` ou `clean`
(retire le bloc de hosts). Les autres options restent les mêmes.

Pour essayer sans droits admin : `--hosts-file /tmp/hosts --state-file /tmp/state.json`.

## Tests

```bash
.venv/bin/python -m pytest
```
