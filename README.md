# 🎮 Openfront Discord Bot

Bot Discord qui cherche automatiquement des vidéos YouTube **Openfront.io en français** et les poste dans un salon, **5 fois par jour** (toutes les ~5h).

---

## 📋 Prérequis

- Compte [Discord Developer Portal](https://discord.com/developers/applications)
- Clé API [YouTube Data v3](https://console.cloud.google.com)
- Compte [Railway](https://railway.app) pour l'hébergement 24/7

---

## ⚙️ Configuration

### 1. Créer le bot Discord

1. Va sur https://discord.com/developers/applications → **New Application**
2. Onglet **Bot** → **Reset Token** → copie le token
3. Onglet **OAuth2 > URL Generator** :
   - Scopes : `bot`
   - Bot Permissions : `Send Messages`, `Embed Links`, `View Channels`
4. Ouvre l'URL générée pour inviter le bot sur ton serveur

### 2. Obtenir une clé YouTube API

1. Va sur https://console.cloud.google.com
2. Crée un projet → **APIs & Services** → **Enable APIs**
3. Cherche **YouTube Data API v3** → Active-la
4. **Credentials** → **Create credentials** → **API Key** → copie la clé

### 3. Récupérer l'ID du salon Discord

1. Sur Discord : **Paramètres** → **Avancé** → active **Mode développeur**
2. Clic droit sur ton salon vidéo → **Copier l'identifiant**

---

## 🚀 Déploiement sur Railway

1. Push ce dossier sur un repo GitHub (public ou privé)
2. Va sur https://railway.app → **New Project** → **Deploy from GitHub repo**
3. Sélectionne ton repo
4. Dans **Variables**, ajoute les 3 variables d'environnement :
   ```
   DISCORD_TOKEN      = ton_token
   YOUTUBE_API_KEY    = ta_cle
   DISCORD_CHANNEL_ID = id_du_salon
   ```
5. Railway lance automatiquement `npm start` — le bot tourne 24/7 !

---

## 🔧 Comportement

| Paramètre | Valeur |
|-----------|--------|
| Vidéos par jour | 5 |
| Intervalle | ~5h |
| Filtre langue | Français (`relevanceLanguage: fr`) |
| Filtre récence | Dernières 24h |
| Anti-doublon | ✅ (mémoire en cours d'exécution) |
| Critère | Titre/description doit contenir "openfront" |

---

## 📁 Structure

```
openfront-bot/
├── index.js          # Bot principal
├── package.json      # Dépendances
├── .env.example      # Variables à remplir
└── README.md         # Ce fichier
```
