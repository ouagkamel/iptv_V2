'use strict';

// Profil de test par défaut de 0.1.18, intégré au dépôt sur demande explicite de l’utilisateur.
/*
 * Réglages utilise le premier élément de cette liste comme source initiale. Le formulaire déduit
 * les champs depuis cette déclaration; le nom explicite apparaît à l'écran et dans les étiquettes
 * associées aux champs. Une adresse HTTP fait apparaître la case d'autorisation correspondante.
 * Pour une livraison sans profil, construire avec `IPTV_SANS_SOURCES=1 npm run dist` : le script
 * de paquetage remplace alors ce fichier par une liste vide, et le contrôle de publication continue
 * de refuser tout `.ipk` qui déclare une source. Le fichier ignoré `secrets.local/profils.js` reste
 * disponible comme override pour les essais locaux du propriétaire.
 */
window.iptvProfils = {
  sources: [
    {
      id: 'p1',
      nom: 'Compte de test',
      url: 'http://kdfgh.com:8080',
      username: 'tjubfkkz',
      password: '789966423'
    }
  ]
};
