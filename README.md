# YouBoost

YouBoost est un prototype de plateforme de découverte dédiée aux petits créateurs. Les vidéos
restent hébergées sur YouTube, tandis que le site fournit un catalogue, une recherche et un fil
personnalisé.

## Fonctionnement sur GitHub Pages

Le site est entièrement statique. GitHub Pages sert automatiquement `index.html` à l'ouverture du
site, puis le navigateur charge `data/videos.json`. Aucun serveur local et aucune commande
`npm start` ne sont nécessaires pour que YouBoost reste accessible en ligne.

## Recommandations

Le site est compatible avec GitHub Pages : tout le classement est calculé dans le navigateur.
Le profil est stocké dans `localStorage` et évolue selon :

- les catégories, créateurs et mots-clés regardés ;
- les vidéos ajoutées aux favoris ;
- les vidéos masquées ;
- la fraîcheur des ajouts ;
- un bonus favorisant les petites chaînes ;
- une part d'exploration qui varie chaque jour.

Le profil de recommandation reste propre à chaque navigateur. Les codes créateurs, les demandes de
publication et la modération sont, eux, gérés par le service serverless Supabase.

Les créateurs se connectent depuis l’icône de profil avec leur code personnel. Le bouton
`Ajouter une vidéo` utilise ensuite cette session sans redemander le code. Le forfait Pro à
10 €/mois ajoute un bonus de visibilité pendant la période attribuée par l’administrateur.

## Ajouter des vidéos au catalogue public

Modifiez [`data/videos.json`](data/videos.json) en ajoutant une entrée :

```json
{
  "id": "identifiant-unique",
  "youtubeId": "ID_DE_LA_VIDEO",
  "title": "Titre de la vidéo",
  "creator": "Nom de la chaîne",
  "creatorInitials": "NC",
  "subscribers": 2400,
  "category": "Tech",
  "tags": ["web", "tutoriel"],
  "description": "Description courte.",
  "duration": "8:24",
  "publishedAt": "2026-06-10T18:00:00Z",
  "addedAt": "2026-06-14T10:00:00Z",
  "views": 1200,
  "accent": "#2563eb"
}
```

Le formulaire créateur envoie désormais les propositions à une Edge Function Supabase. Aucun
serveur personnel n'a besoin de rester allumé. Le projet Supabase `tyeyjsflihxygkospkjk` est déjà
relié dans `index.html`. Le catalogue statique continue de fonctionner lorsque l'API est
indisponible.

## Déployer sur GitHub Pages

1. Envoyez ces fichiers dans un dépôt GitHub.
2. Ouvrez `Settings > Pages`.
3. Dans `Build and deployment`, choisissez `Deploy from a branch`.
4. Sélectionnez la branche principale et le dossier `/ (root)`.

Les fiches présentes par défaut sont des données de démonstration. Remplacez-les par les vrais
créateurs sélectionnés avant une publication publique.
