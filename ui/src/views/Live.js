'use strict';

/**
 * Live TV (V1-A) : **catégories à gauche, chaînes à droite** (§3.1, §4.3).
 *
 * - les catégories viennent de `getCategories` (index déjà écrit, ordre fournisseur, aucun appel
 *   fournisseur pour ouvrir l'écran) ;
 * - la liste des chaînes est **paginée par le service** (`getPage` + curseur) et chargée à la
 *   demande : la TV ne tient jamais 5 000 chaînes en mémoire ;
 * - OK sur une chaîne lance le lecteur avec la **file de lecture** de la catégorie affichée (§4.6).
 */

import React from 'react';
import {Panel} from '@enact/sandstone/Panels';
import BodyText from '@enact/sandstone/BodyText';
import Item from '@enact/sandstone/Item';
import Spinner from '@enact/sandstone/Spinner';
import VirtualList from '@enact/sandstone/VirtualList';
import ri from '@enact/ui/resolution';

import {useApp} from '../App/AppContexte';
import service from '../services/service';
import css from './Live.module.less';

const ETAT_VIDE = {
	categories: [],
	categorieId: '',
	chaines: [],
	curseur: null,
	chargement: false,
	termine: false,
	erreur: ''
};

/** Une chaîne de la liste : la sélection passe par une prop, jamais par une fonction anonyme. */
function LigneChaine({chaine, index, onOuvrir, ...rest}) {
	const ouvrir = React.useCallback(() => onOuvrir(index), [onOuvrir, index]);
	return (
		<Item {...rest} onClick={ouvrir}>
			{chaine.title}
		</Item>
	);
}

/** Une catégorie de la colonne de gauche. */
function LigneCategorie({categorie, active, onChoisir}) {
	const choisir = React.useCallback(() => onChoisir(categorie.id), [onChoisir, categorie.id]);
	return (
		<Item className={active ? css.categorieActive : css.categorie} onClick={choisir}>
			{categorie.name} ({categorie.count})
		</Item>
	);
}

function Live() {
	const {profil, signaler, lancer} = useApp();
	const [etat, setEtat] = React.useState(ETAT_VIDE);
	const etatRef = React.useRef(etat);
	etatRef.current = etat;

	const signalerEchec = React.useCallback(
		(resultat, quoi) => {
			const texte = service.messageDe(resultat);
			setEtat((precedent) => Object.assign({}, precedent, {erreur: texte, chargement: false}));
			signaler(quoi + ' : ' + texte, 'erreur');
		},
		[signaler]
	);

	/** Chargement d'une page de chaînes, en conservant ce qui est déjà affiché. */
	const chargerPage = React.useCallback(
		(categorieId, curseur) => {
			setEtat((precedent) => Object.assign({}, precedent, {chargement: true}));
			service
				.getPage({
					profileId: profil.profilId,
					contentType: 'live',
					categoryId: categorieId,
					order: 'source',
					cursor: curseur
				})
				.then((resultat) => {
					if (!resultat.ok) {
						signalerEchec(resultat, 'chaînes');
						return;
					}
					const page = resultat.data || {};
					setEtat((precedent) =>
						Object.assign({}, precedent, {
							chaines: curseur ? precedent.chaines.concat(page.items || []) : page.items || [],
							curseur: page.cursor || null,
							termine: !page.cursor,
							chargement: false,
							erreur: ''
						})
					);
				})
				.catch((erreur) => {
					signalerEchec({error: {code: 'bridge/unavailable', message: erreur.message}}, 'chaînes');
				});
		},
		[profil.profilId, signalerEchec]
	);

	const chargerCategories = React.useCallback(() => {
		setEtat((precedent) => Object.assign({}, precedent, {chargement: true}));
		service.getCategories(profil.profilId, 'live').then((resultat) => {
			if (!resultat.ok) {
				setEtat((precedent) => Object.assign({}, precedent, {chargement: false}));
				signalerEchec(resultat, 'catégories');
				return;
			}
			const categories = (resultat.data && resultat.data.categories) || [];
			const premiere = categories.length ? categories[0].id : '';
			setEtat((precedent) =>
				Object.assign({}, precedent, {
					categories,
					categorieId: premiere,
					chaines: [],
					curseur: null,
					termine: false
				})
			);
			if (premiere) chargerPage(premiere, null);
		});
	}, [profil.profilId, chargerPage, signalerEchec]);

	React.useEffect(() => {
		if (profil.profilId) chargerCategories();
	}, [profil.profilId, chargerCategories]);

	/** Chargement à l'approche du bas de liste : la TV ne demande que ce qu'elle affiche. */
	const surArretDefilement = React.useCallback(() => {
		const courant = etatRef.current;
		if (courant.chargement || courant.termine || !courant.curseur) return;
		chargerPage(courant.categorieId, courant.curseur);
	}, [chargerPage]);

	const choisirCategorie = React.useCallback(
		(id) => {
			setEtat((precedent) =>
				Object.assign({}, precedent, {categorieId: id, chaines: [], curseur: null, termine: false})
			);
			chargerPage(id, null);
		},
		[chargerPage]
	);

	/** OK sur une chaîne : file = liste affichée, dans son ordre (§4.6, zapping sans saut de catégorie). */
	const ouvrirChaine = React.useCallback(
		(index) => {
			const courant = etatRef.current;
			const nom = courant.categories.filter((categorie) => categorie.id === courant.categorieId)[0];
			lancer({
				profilId: profil.profilId,
				contentType: 'live',
				file: courant.chaines.map((chaine) => ({ref: chaine.ref, titre: chaine.title})),
				index,
				titreFile: 'Catégorie ' + (nom ? nom.name : '')
			});
		},
		[lancer, profil.profilId]
	);

	const renduChaine = React.useCallback(
		({index, ...rest}) => {
			const chaine = etat.chaines[index];
			if (!chaine) return <Item {...rest} key={'vide-' + index} />;
			return <LigneChaine {...rest} key={chaine.ref.providerId} chaine={chaine} index={index} onOuvrir={ouvrirChaine} />;
		},
		[etat.chaines, ouvrirChaine]
	);

	const vide = !etat.chargement && etat.chaines.length === 0;

	return (
		<Panel className={css.live}>
			<div className={css.panneaux}>
				<div className={css.categories}>
					<BodyText className={css.entete}>Catégories ({etat.categories.length})</BodyText>
					{etat.categories.map((categorie) => (
						<LigneCategorie
							key={categorie.id}
							categorie={categorie}
							active={categorie.id === etat.categorieId}
							onChoisir={choisirCategorie}
						/>
					))}
					{etat.categories.length === 0 ? (
						<BodyText className={css.vide}>
							Aucune catégorie : importer la source depuis Réglages → « Importer (live) ».
						</BodyText>
					) : null}
				</div>

				<div className={css.chaines}>
					{etat.chargement && etat.chaines.length === 0 ? <Spinner /> : null}
					{vide ? (
						<BodyText className={css.vide}>
							{etat.erreur ? 'Chargement impossible : ' + etat.erreur : 'Aucune chaîne dans cette catégorie.'}
						</BodyText>
					) : null}
					{etat.chaines.length > 0 ? (
						<VirtualList
							itemRenderer={renduChaine}
							itemSize={ri.scale(72)}
							dataSize={etat.chaines.length}
							onScrollStop={surArretDefilement}
							className={css.liste}
						/>
					) : null}
				</div>
			</div>
		</Panel>
	);
}

export default Live;
