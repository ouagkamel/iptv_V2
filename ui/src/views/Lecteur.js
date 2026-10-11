'use strict';

/**
 * Lecteur (V1-A) : **un seul `<video>` natif**, alimenté par `resolveStream()` appelé juste avant la
 * lecture (§6.1, §15.4). Aucune URL de flux n'est réutilisée après son expiration.
 *
 * Règles appliquées :
 *  - la vidéo **ne prend jamais le focus** (§4.3) : Spotlight est mis en pause pendant la lecture et
 *    le lecteur écoute lui-même les touches de la télécommande ;
 *  - **Live sans DVR** : Haut/Bas zappent dans la file de lecture, Gauche/Droite affichent l'overlay
 *    et ne cherchent jamais dans un direct sans `seekable` (§4.6) ;
 *  - Retour quitte le lecteur ; la file et la sélection restent à l'écran d'origine (§4.6) ;
 *  - un échec de `resolveStream` ou une `MediaError` donne un message normalisé, jamais un écran noir
 *    muet ; une URL expirée est re-résolue **une** fois ;
 *  - **formats (0B)** : l'ordre d'essai est celui que la plateforme déclare (`canPlayType`) — HLS
 *    d'abord, MPEG-TS ensuite — et l'autre conteneur est essayé **une** fois avant d'abandonner
 *    (D-44). Le message final nomme les formats réellement essayés.
 *  - **voie de secours (D-45)** : quand ces deux conteneurs natifs échouent alors que la plateforme
 *    expose MSE, `hls.js` est chargé (à la demande) et alimente le **même** `<video>` — jamais un
 *    second élément, jamais sur le chemin par défaut (§422). Un moteur sans lecteur HLS intégré ni
 *    démultiplexeur MPEG-TS (Chromium sans HLS natif, donc le simulateur) n'a que cette voie-là.
 */

import React from 'react';
import BodyText from '@enact/sandstone/BodyText';
import Button from '@enact/sandstone/Button';
import Spinner from '@enact/sandstone/Spinner';
import Spotlight from '@enact/spotlight';

import service from '../services/service';
import hlsjs from '../services/hls';
import mediaformats from '../../../src/app/mediaformats.js';
import css from './Lecteur.module.less';

const TOUCHES = {GAUCHE: 37, DROITE: 39, HAUT: 38, BAS: 40, OK: 13, RETOUR: 461, ECHAP: 27};

class Lecteur extends React.Component {
	constructor(props) {
		super(props);
		const entree = props.lecture && props.lecture.file[props.lecture.index];
		this.state = {
			etat: props.lecture ? 'preparation' : 'inactif',
			titre: entree ? entree.titre : '',
			index: props.lecture ? props.lecture.index : 0,
			url: '',
			overlay: false,
			erreur: '',
			reessaye: false,
			format: 'hls',
			formatEffectif: '',
			formatsEssayes: [],
			// voie de secours (D-45) : `mse` dit que la source est poussée par hls.js, `mseTentee`
			// borne le repli à **une** tentative — après quoi l'échec est dit, jamais bouclé.
			mse: false,
			mseTentee: false,
			detail: ''
		};
		// Ordre d'essai des conteneurs : fixé après le premier rendu (le `<video>` doit exister)
		this.candidats = ['hls', 'ts'];
		this.rangFormat = 0;
		this.video = React.createRef();
		this.surTouche = this.surTouche.bind(this);
		this.surErreurMedia = this.surErreurMedia.bind(this);
		this.surLectureEnCours = this.surLectureEnCours.bind(this);
		this.surClicReessayer = this.surClicReessayer.bind(this);
		this.surClicQuitter = this.surClicQuitter.bind(this);
	}

	componentDidMount() {
		// Le lecteur prend la main sur les touches : Spotlight est remis en route en sortant seulement.
		Spotlight.pause();
		document.addEventListener('keydown', this.surTouche, true);
		// Ce que la plateforme **déclare** savoir lire décide du premier format demandé (D-44).
		const video = this.video.current;
		this.candidats = mediaformats.candidats(video && typeof video.canPlayType === 'function' ? video.canPlayType.bind(video) : null);
		if (this.props.lecture) this.preparer(this.props.lecture.index);
	}

	componentWillUnmount() {
		document.removeEventListener('keydown', this.surTouche, true);
		Spotlight.resume();
		this.arreterFlux();
	}

	/** Détruit l'instance `hls.js` : aucune segmentation ne doit survivre à un zapping (§4.6). */
	arreterMse() {
		if (this.hls) {
			try {
				this.hls.destroy();
			} catch (_erreur) {
				/* une instance déjà détruite ne doit pas bloquer la sortie du lecteur */
			}
			this.hls = null;
		}
	}

	arreterFlux() {
		this.arreterMse();
		const video = this.video.current;
		if (video) {
			try {
				video.pause();
				video.removeAttribute('src');
				video.load();
			} catch (_erreur) {
				/* un arrêt raté ne doit pas bloquer la sortie du lecteur */
			}
		}
	}

	/** Résolution puis lecture : `resolveStream` est appelée **juste avant** de lire (§15.4). */
	preparer(index, format, reessaye) {
		const {lecture} = this.props;
		if (!lecture || !lecture.file[index]) return;
		const entree = lecture.file[index];
		const demande = format || this.candidats[this.rangFormat] || 'hls';
		// Toute tentative native repart d'une source `src` : l'instance MSE éventuelle est détruite.
		this.arreterMse();
		this.setState({
			etat: 'preparation',
			index,
			titre: entree.titre,
			erreur: '',
			detail: '',
			url: '',
			format: demande,
			formatEffectif: '',
			mse: false,
			reessaye: reessaye === true
		});
		service
			.resolveStream({profileId: lecture.profilId, ref: entree.ref, requestedFormat: demande})
			.then((resultat) => {
				if (!resultat.ok) {
					this.setState({etat: 'erreur', erreur: service.messageDe(resultat)});
					return;
				}
				const resolution = resultat.data || {};
				// L'URL **réellement** servie peut ne pas être dans le format demandé : un mode
				// `storedSecret` rend l'URL mémorisée à l'import (son conteneur est celui du profil).
				// Le dire évite de recharger deux fois la même URL sous deux étiquettes différentes.
				const effectif =
					resolution.preferredMime === mediaformats.MIME.hls
						? 'hls'
						: resolution.preferredMime === mediaformats.MIME.ts
							? 'ts'
							: demande;
				this.setState({etat: 'lecture', url: resolution.url || '', formatEffectif: effectif});
			})
			.catch((erreur) => this.setState({etat: 'erreur', erreur: erreur.message}));
	}

	/** Haut/Bas = zap (live sans DVR) ; Gauche/Droite = overlay ; OK = overlay ; Retour = sortie. */
	surTouche(evenement) {
		const code = evenement.keyCode;
		const file = (this.props.lecture && this.props.lecture.file) || [];
		if (code === TOUCHES.HAUT || code === TOUCHES.BAS) {
			const cible = this.state.index + (code === TOUCHES.HAUT ? -1 : 1);
			if (file.length > 0 && cible >= 0 && cible < file.length) {
				this.arreterFlux();
				this.preparer(cible);
			}
			evenement.preventDefault();
			return;
		}
		if (code === TOUCHES.GAUCHE || code === TOUCHES.DROITE) {
			// Direct sans DVR : on n'essaie pas de chercher, on montre l'overlay (§4.6).
			this.setState({overlay: true});
			evenement.preventDefault();
			return;
		}
		if (code === TOUCHES.OK) {
			this.setState((precedent) => ({overlay: !precedent.overlay}));
			evenement.preventDefault();
			return;
		}
		if (code === TOUCHES.RETOUR || code === TOUCHES.ECHAP) {
			this.quitter();
			evenement.preventDefault();
		}
	}

	/**
	 * Échec média : quatre marches seulement, dans cet ordre — (1) re-résoudre le **même** format
	 * (une URL peut avoir expiré), (2) essayer l'**autre** conteneur natif, (3) la voie MSE si la
	 * plateforme l'expose (D-45), (4) abandonner en disant ce qui a été essayé. Jamais de boucle :
	 * un format n'est demandé qu'une fois, plus une re-résolution, et le repli est borné à une
	 * tentative.
	 */
	surErreurMedia() {
		if (this.state.mse) {
			// La source est poussée par hls.js : ses propres reprises ont déjà eu lieu (fragment,
			// niveau, manifeste). Une erreur média à ce stade est définitive — on la dit.
			this.arreterMse();
			this.echouerAvecMse();
			return;
		}
		// Ce qui compte pour la liste des essais est le **conteneur réellement servi**, pas le format
		// demandé : demander « ts » sur un index qui mémorise des URL `.m3u8` renvoie la même URL.
		const effectif = this.state.formatEffectif || this.state.format;
		const essayes = this.state.formatsEssayes.indexOf(effectif) === -1
			? this.state.formatsEssayes.concat([effectif])
			: this.state.formatsEssayes.slice();
		if (this.state.url && !this.state.reessaye) {
			// même format, une seule re-résolution (URL expirée)
			this.setState({reessaye: true, formatsEssayes: essayes}, () => this.preparer(this.state.index, this.state.format, true));
			return;
		}
		const suivant = mediaformats.autre(effectif);
		if (suivant && essayes.indexOf(suivant) === -1) {
			// l'autre conteneur : c'est ce que la 0B demande de qualifier, il se tente
			this.rangFormat = Math.max(0, this.candidats.indexOf(suivant));
			this.setState({formatsEssayes: essayes}, () => this.preparer(this.state.index, suivant));
			return;
		}
		if (!this.state.mseTentee && mediaformats.mseSupport(window)) {
			// Dernière marche : le moteur n'a peut-être aucun lecteur natif pour ce flux (ni HLS
			// intégré, ni démultiplexeur MPEG-TS). hls.js lit la playlist et pousse les segments
			// dans le **même** `<video>` par MSE.
			this.setState({formatsEssayes: essayes, mseTentee: true}, () => this.preparerMse());
			return;
		}
		this.echouer(essayes);
	}

	/**
	 * Voie de secours (D-45) : URL HLS fraîche puis `hls.js` sur le `<video>` existant. Rien n'est
	 * tenté si la plateforme n'expose pas MSE pour le H.264/AAC, ni si la résolution rend autre
	 * chose qu'une playlist (hls.js ne lit pas un flux MPEG-TS brut) : dans ces cas l'échec est dit
	 * avec ce qui manquait, plutôt que déguisé en tentative.
	 */
	preparerMse() {
		const {lecture} = this.props;
		const entree = lecture && lecture.file[this.state.index];
		if (!entree) return;
		if (!mediaformats.mseSupport(window)) {
			this.echouerAvecMse('MSE absent : repli hls.js impossible');
			return;
		}
		this.arreterMse();
		this.setState({etat: 'preparation', url: '', erreur: '', detail: '', mse: true, format: 'hls', formatEffectif: mediaformats.LIBELLE_MSE});
		service
			.resolveStream({profileId: lecture.profilId, ref: entree.ref, requestedFormat: 'hls'})
			.then((resultat) => {
				if (!this.state.mse) return; // la lecture a été quittée pendant la résolution
				if (!resultat.ok) {
					this.echouerAvecMse('résolution mse : ' + service.messageDe(resultat));
					return;
				}
				const url = (resultat.data && resultat.data.url) || '';
				if (!mediaformats.estHls(url)) {
					this.echouerAvecMse('le service n’a pas rendu de playlist HLS pour le repli');
					return;
				}
				this.setState({url: url}, () => this.demarrerMse(url));
			})
			.catch((erreur) => this.echouerAvecMse('résolution mse : ' + erreur.message));
	}

	/** Charge `hls.js` (à la demande) et alimente le `<video>` par MSE. */
	demarrerMse(url) {
		const video = this.video.current;
		if (!video) {
			this.echouerAvecMse('aucun élément vidéo pour le repli');
			return;
		}
		hlsjs
			.chargerHls()
			.then((Hls) => {
				if (!this.state.mse) return; // quitté pendant le chargement du script
				this.arreterMse();
				const lecteurHls = new Hls({enableWorker: true, lowLatencyMode: false});
				this.hls = lecteurHls;
				lecteurHls.on(Hls.Events.ERROR, (_evenement, donnees) => {
					if (!donnees || !donnees.fatal) return;
					// Détail utile au diagnostic 0A : hls.js nomme la cause (réseau, manifeste, média).
					this.echouerAvecMse('repli mse : ' + donnees.type + '/' + donnees.details);
				});
				lecteurHls.on(Hls.Events.MANIFEST_PARSED, () => {
					if (!this.state.mse) return;
					this.setState({etat: 'lecture'});
					const lancement = video.play();
					if (lancement && typeof lancement.catch === 'function') lancement.catch(() => {});
				});
				lecteurHls.loadSource(url);
				lecteurHls.attachMedia(video);
			})
			.catch((erreur) => this.echouerAvecMse('repli mse : ' + erreur.message));
	}

	/** Échec de la voie MSE : elle rejoint la liste des essais, puis le message final est rendu. */
	echouerAvecMse(detail) {
		this.arreterMse();
		const essayes = this.state.formatsEssayes.indexOf(mediaformats.LIBELLE_MSE) === -1
			? this.state.formatsEssayes.concat([mediaformats.LIBELLE_MSE])
			: this.state.formatsEssayes.slice();
		this.echouer(essayes, detail);
	}

	/** Échec définitif : la liste des formats essayés et, si elle existe, la cause technique. */
	echouer(formats, detail) {
		const video = this.video.current;
		const code = video && video.error ? video.error.code : 0;
		this.setState((precedent) => {
			const essayes = formats || precedent.formatsEssayes;
			return {
				etat: 'erreur',
				mse: false,
				formatsEssayes: essayes,
				erreur: mediaformats.messageErreurMedia(code, essayes),
				detail: detail || precedent.detail || ''
			};
		});
	}

	surLectureEnCours() {
		this.setState({etat: 'lecture'});
	}

	surClicReessayer() {
		// Réessayer repart de l'ordre déclaré par la plateforme : l'état d'essai est remis à zéro,
		// y compris la voie de secours (une nouvelle tentative native d'abord, comme au premier essai).
		this.rangFormat = 0;
		this.arreterMse();
		this.setState({reessaye: false, formatsEssayes: [], mse: false, mseTentee: false, detail: ''}, () =>
			this.preparer(this.state.index)
		);
	}

	surClicQuitter() {
		this.quitter();
	}

	quitter() {
		this.arreterFlux();
		if (this.props.onQuitter) this.props.onQuitter();
	}

	render() {
		const {lecture} = this.props;
		if (!lecture) {
			return (
				<div className={css.lecteur}>
					<BodyText className={css.texte}>Aucune lecture en cours.</BodyText>
				</div>
			);
		}
		const file = lecture.file || [];
		return (
			<div className={css.lecteur}>
				{/* En voie MSE (§D-45), la source est le `blob:` que hls.js attache lui-même : aucune URL
				    n'est posée ici, sous peine d'écraser la SourceBuffer au rendu suivant. */}
				<video
					ref={this.video}
					className={css.video}
					src={this.state.mse ? undefined : this.state.url || undefined}
					autoPlay
					playsInline
					onError={this.surErreurMedia}
					onPlaying={this.surLectureEnCours}
				/>
				{this.state.etat === 'preparation' ? (
					<div className={css.centre}>
						<Spinner />
						<BodyText className={css.texte}>Préparation du flux…</BodyText>
					</div>
				) : null}
				{this.state.etat === 'erreur' ? (
					<div className={css.centre}>
						<BodyText className={css.texte}>{this.state.erreur}</BodyText>
						{/* Cause technique, quand la voie de secours a parlé : elle sert au rapport 0A
						    et évite d'avoir à deviner si l'échec est réseau, manifeste ou média. */}
						{this.state.detail ? <BodyText className={css.petit}>{this.state.detail}</BodyText> : null}
						<Button onClick={this.surClicReessayer}>Réessayer</Button>
						<Button onClick={this.surClicQuitter}>Quitter</Button>
					</div>
				) : null}
				<div className={this.state.overlay ? css.overlayVisible : css.overlay}>
					<BodyText className={css.titre}>{this.state.titre}</BodyText>
					<BodyText className={css.petit}>
						{file.length > 1 ? 'chaîne ' + (this.state.index + 1) + ' / ' + file.length : ''}
						{lecture.titreFile ? ' · ' + lecture.titreFile : ''}
					</BodyText>
					<Button onClick={this.surClicQuitter}>Quitter</Button>
				</div>
			</div>
		);
	}
}

export default Lecteur;
