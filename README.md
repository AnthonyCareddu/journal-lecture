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

## Configuration

En haut de `app.js` (`DEFAULTS`) : URL de l'API et ID client Google.
Surchargables à l'exécution via **⚙️ → Réglages avancés** (stockés en `localStorage`).

Le back-end (projet Apps Script lié à la feuille BDD) expose les actions
`bootstrap · month · stats · sessions · addSession · updateSession · deleteSession ·
saveBook · createBook · mergeBooks · setChrono · saveReglages · setRunning`.
