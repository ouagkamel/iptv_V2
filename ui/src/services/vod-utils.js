'use strict';

/** Helpers d'affichage VOD : purs pour rester simples à vérifier sans le runtime Enact. */
function formaterDuree(secondes) {
  const valeur = typeof secondes === 'number' ? secondes : typeof secondes === 'string' ? Number(secondes) : NaN;
  if (!isFinite(valeur) || valeur <= 0) return '';

  const minutes = Math.max(1, Math.round(valeur / 60));
  if (minutes < 60) return minutes + ' min';

  const heures = Math.floor(minutes / 60);
  const reste = minutes % 60;
  return heures + ' h' + (reste ? ' ' + reste + ' min' : '');
}

function libelleSecondaire(film) {
  const valeur = film || {};
  const morceaux = [];
  if (typeof valeur.year === 'number' && isFinite(valeur.year) && valeur.year > 0) morceaux.push(String(valeur.year));
  const duree = formaterDuree(valeur.durationSeconds);
  if (duree) morceaux.push(duree);
  return morceaux.join(' · ');
}

/** N'affiche que des posters HTTP(S) ; les schémas actifs, fichiers et URL avec userinfo sont refusés. */
function urlAffiche(valeur) {
  if (typeof valeur !== 'string') return '';
  const url = valeur.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return '';
  const autorite = url.match(/^https?:\/\/([^/?#]*)/i);
  if (!autorite || autorite[1].indexOf('@') !== -1) return '';
  return url;
}

module.exports = {
  formaterDuree: formaterDuree,
  libelleSecondaire: libelleSecondaire,
  urlAffiche: urlAffiche
};
