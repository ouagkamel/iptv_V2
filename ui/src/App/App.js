'use strict';

/**
 * Application V1-A (§1.4) : accueil à quatre cartes, barre de navigation globale, Live TV
 * (catégories + chaînes), lecteur natif alimenté par `resolveStream()`, réglages du profil Xtream
 * (test, consentement, erreurs normalisées) et diagnostic local minimal.
 *
 * Les écrans non livrés dans l'incrément (Films, Séries) sont **masqués proprement** : ils annoncent
 * l'incrément qui les apporte au lieu d'une grille vide (§1.4). Le lecteur est un panneau à part :
 * Retour le quitte et rend l'écran d'origine à sa position (§4.6).
 *
 * Pile de panneaux : 0 = accueil, 1 = contenu (barre de navigation + section), 2 = lecteur.
 */

import React from 'react';
import {Panels, Panel, Header} from '@enact/sandstone/Panels';
import TabLayout, {Tab} from '@enact/sandstone/TabLayout';

import {Fournisseur} from './AppContexte';
import Accueil from '../views/Accueil';
import Live from '../views/Live';
import Vod from '../views/Vod';
import Series from '../views/Series';
import Reglages from '../views/Reglages';
import Lecteur from '../views/Lecteur';
import profils from '../services/profils';
import service from '../services/service';

import css from './App.module.less';

const SECTIONS = [
	{cle: 'live', titre: 'Live TV', icone: 'live', ecran: Live},
	{cle: 'vod', titre: 'Films', icone: 'movie', ecran: Vod},
	{cle: 'series', titre: 'Séries', icone: 'series', ecran: Series},
	{cle: 'reglages', titre: 'Réglages', icone: 'settings', ecran: Reglages}
];

/** Index d'onglet d'une section ; 0 par défaut si la clé est inconnue. */
function indexDe(cle) {
	const index = SECTIONS.findIndex((entree) => entree.cle === cle);
	return index < 0 ? 0 : index;
}

class App extends React.Component {
	constructor(props) {
		super(props);
		this.state = {
			vues: ['accueil'],
			section: 'live',
			profil: profils.etatInitial(),
			messages: [],
			lecture: null,
			diagnostic: null
		};
		this.allerAuContenu = this.allerAuContenu.bind(this);
		this.retour = this.retour.bind(this);
		this.majProfil = this.majProfil.bind(this);
		this.signaler = this.signaler.bind(this);
		this.lancer = this.lancer.bind(this);
		this.quitterLecteur = this.quitterLecteur.bind(this);
		this.rafraichirDiagnostic = this.rafraichirDiagnostic.bind(this);
		this.surSelectOnglet = this.surSelectOnglet.bind(this);
	}

	componentDidMount() {
		// Diagnostic local minimal (§0A) : premier repère si un écran reste vide faute d'index ou de DB8.
		this.rafraichirDiagnostic();
	}

	/** Message affiché en surimpression : toujours le texte exact de la cause (jamais d'objet, D-24). */
	signaler(texte, type) {
		this.setState((precedent) => ({
			messages: precedent.messages
				.slice(-2)
				.concat([{texte: String(texte), type: type === 'erreur' ? 'erreur' : 'info'}])
		}));
	}

	allerAuContenu(section) {
		this.setState((precedent) => ({
			section: section || precedent.section,
			vues: ['accueil', 'contenu']
		}));
	}

	retour() {
		this.setState((precedent) => {
			const vues = precedent.vues.slice();
			const partie = vues.pop();
			return {
				lecture: partie === 'lecteur' ? null : precedent.lecture,
				vues: vues.length ? vues : ['accueil']
			};
		});
	}

	majProfil(partiel) {
		this.setState((precedent) => ({profil: Object.assign({}, precedent.profil, partiel)}));
	}

	/** File de lecture explicite transmise au lecteur (§4.6), avec l'index de départ. */
	lancer(lecture) {
		this.setState({lecture, vues: ['accueil', 'contenu', 'lecteur']});
	}

	quitterLecteur() {
		this.setState({lecture: null, vues: ['accueil', 'contenu']});
	}

	surSelectOnglet(evenement) {
		const cible = SECTIONS[evenement.index];
		if (cible) this.setState({section: cible.cle});
	}

	rafraichirDiagnostic() {
		service.diagnostics().then((resultat) => {
			this.setState({diagnostic: resultat});
			if (!resultat.ok) this.signaler('diagnostic : ' + service.messageDe(resultat), 'erreur');
		});
	}

	render() {
		const {vues, section, profil, messages, lecture, diagnostic} = this.state;
		const valeur = {
			profil,
			majProfil: this.majProfil,
			section,
			allerAuContenu: this.allerAuContenu,
			signaler: this.signaler,
			lancer: this.lancer,
			diagnostic,
			rafraichirDiagnostic: this.rafraichirDiagnostic
		};
		const titreProfil = profil.nom ? 'profil : ' + profil.nom : null;

		return (
			<Fournisseur valeur={valeur}>
				<Panels index={vues.length - 1} onBack={this.retour} className={css.app}>
					<Panel className={css.panneau}>
						<Header title="IPTV V2" subtitle={titreProfil} />
						<Accueil sections={SECTIONS} />
					</Panel>

					<Panel className={css.panneau}>
						<Header title={SECTIONS[indexDe(section)].titre} subtitle={titreProfil} />
						<TabLayout className={css.contenu} index={indexDe(section)} onSelect={this.surSelectOnglet}>
							{SECTIONS.map((entree) => {
								const Ecran = entree.ecran;
								return (
									<Tab key={entree.cle} title={entree.titre} icon={entree.icone}>
										<Ecran />
									</Tab>
								);
							})}
						</TabLayout>
					</Panel>

					<Panel className={css.panneauLecteur}>
						<Lecteur lecture={lecture} onQuitter={this.quitterLecteur} />
					</Panel>
				</Panels>

				<div className={css.messages}>
					{messages.map((message, index) => (
						<div key={index} className={message.type === 'erreur' ? css.erreur : css.info}>
							{message.texte}
						</div>
					))}
				</div>
			</Fournisseur>
		);
	}
}

export default App;
