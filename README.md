# Journal de Lecture

PWA de suivi de lecture : chrono de session, vue mensuelle avec code couleur,
statistiques, gestion des livres (format / nature / statut), journal éditable.

- **Interface** : cette PWA (GitHub Pages) — `https://anthonycareddu.github.io/journal-lecture/`
- **Base de données** : Google Sheet, via un endpoint Apps Script (`doPost`)
- **Auth** : Google Sign-In (compte autorisé unique), jeton de session signé
- **Hors ligne** : coquille en cache (service worker) + file d'attente des séances

## Fichiers

| | |
|---|---|
| `index.html` | coquille : écran de connexion, application, réglages |
| `styles.css` | thème clair/sombre, police Fraunces |
| `app.js` | logique : API, auth, file d'attente hors ligne, écrans |
| `sw.js` | service worker (cache de la coquille uniquement) |
| `manifest.webmanifest` | métadonnées d'installation |
| `icons/` | icônes PWA |
| `Code.gs` | **back-end** — copie de référence du script Apps Script lié à la feuille BDD |

## Configuration

En haut de `app.js` (`DEFAULTS`) : URL de l'API et ID client Google.
Surchargables à l'exécution via **⚙️ → Réglages avancés** (stockés en `localStorage`).

## Back-end (`Code.gs`)

Projet Apps Script **lié** à la feuille « Journal de Lecture — Base de données »
(onglets `sessions` · `livres` · `reglages`). `Code.gs` ici est la copie de référence :
après modification, la coller dans l'éditeur puis **Déployer ▸ Gérer les déploiements ▸
(crayon) ▸ Version : Nouvelle version** (l'URL `/exec` ne change pas).

Actions exposées à la PWA :
`bootstrap · month · stats · sessions · addSession · updateSession · deleteSession ·
saveBook · createBook · mergeBooks · setChrono · saveReglages · setRunning`

Fonctions à lancer à la main depuis l'éditeur :
`setupBase` (création des onglets) · `importerHistorique` / `reimporter` (migration de
l'ancienne feuille) · `corrigerStatuts` (rattrapage des statuts mal devinés à la migration) ·
`diagnostic` · `autoriser`.
