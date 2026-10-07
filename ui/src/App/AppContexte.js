'use strict';

/**
 * État partagé de l'application (V1-A) : profil actif, diagnostic, messages, file de lecture.
 *
 * Volontairement minimal : un objet React ordinaire propagé par `React.createContext`, sans
 * bibliothèque d'état. Les écrans lisent et écrivent par les fonctions fournies ici, ce qui garde
 * les règles métier (verdict métier, erreurs normalisées) dans `services/service.js`.
 */

import React from 'react';

const Contexte = React.createContext(null);

/** Fournisseur : l'appelant construit l'état (voir `App.js`). */
export function Fournisseur({valeur, children}) {
	return <Contexte.Provider value={valeur}>{children}</Contexte.Provider>;
}

/** Accès à l'état : lève une erreur explicite si un écran est monté hors du fournisseur. */
export function useApp() {
	const valeur = React.useContext(Contexte);
	if (!valeur) throw new Error("useApp : le contexte de l'application est absent");
	return valeur;
}
