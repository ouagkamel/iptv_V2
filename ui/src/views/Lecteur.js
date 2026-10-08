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
 */

import React from 'react';
import BodyText from '@enact/sandstone/BodyText';
import Button from '@enact/sandstone/Button';
import Spinner from '@enact/sandstone/Spinner';
import Spotlight from '@enact/spotlight';

import service from '../services/service';
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
			formatsEssayes: []
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

	arreterFlux() {
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
		this.setState({
			etat: 'preparation',
			index,
			titre: entree.titre,
			erreur: '',
			url: '',
			format: demande,
			formatEffectif: '',
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
	 * Échec média : trois marches seulement, dans cet ordre — (1) re-résoudre le **même** format (une
	 * URL peut avoir expiré), (2) essayer l'**autre** conteneur, (3) abandonner en disant ce qui a été
	 * essayé. Jamais de boucle : un format n'est demandé qu'une fois, plus une re-résolution.
	 */
	surErreurMedia() {
		const video = this.video.current;
		const code = video && video.error ? video.error.code : 0;
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
		this.setState({
			etat: 'erreur',
			formatsEssayes: essayes,
			erreur: mediaformats.messageErreurMedia(code, essayes)
		});
	}

	surLectureEnCours() {
		this.setState({etat: 'lecture'});
	}

	surClicReessayer() {
		// Réessayer repart de l'ordre déclaré par la plateforme : l'état d'essai est remis à zéro.
		this.rangFormat = 0;
		this.setState({reessaye: false, formatsEssayes: []}, () => this.preparer(this.state.index));
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
				<video
					ref={this.video}
					className={css.video}
					src={this.state.url || undefined}
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
