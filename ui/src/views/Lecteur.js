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
 *    muet ; une URL expirée est re-résolue **une** fois.
 */

import React from 'react';
import BodyText from '@enact/sandstone/BodyText';
import Button from '@enact/sandstone/Button';
import Spinner from '@enact/sandstone/Spinner';
import Spotlight from '@enact/spotlight';

import service from '../services/service';
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
			reessaye: false
		};
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
	preparer(index) {
		const {lecture} = this.props;
		if (!lecture || !lecture.file[index]) return;
		const entree = lecture.file[index];
		this.setState({etat: 'preparation', index, titre: entree.titre, erreur: '', url: ''});
		service
			.resolveStream({profileId: lecture.profilId, ref: entree.ref, requestedFormat: 'auto'})
			.then((resultat) => {
				if (!resultat.ok) {
					this.setState({etat: 'erreur', erreur: service.messageDe(resultat)});
					return;
				}
				const resolution = resultat.data || {};
				this.setState({etat: 'lecture', url: resolution.url || ''});
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

	surErreurMedia() {
		const video = this.video.current;
		const code = video && video.error ? video.error.code : 0;
		if (this.state.url && !this.state.reessaye) {
			this.setState({reessaye: true}, () => this.preparer(this.state.index));
			return;
		}
		this.setState({
			etat: 'erreur',
			erreur: 'lecture impossible (MediaError ' + code + ') — flux expiré ou format non pris en charge'
		});
	}

	surLectureEnCours() {
		this.setState({etat: 'lecture'});
	}

	surClicReessayer() {
		this.setState({reessaye: false}, () => this.preparer(this.state.index));
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
