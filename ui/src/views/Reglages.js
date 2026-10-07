'use strict';

/**
 * Réglages (V1-A) : profil Xtream (test, consentement, import), diagnostic local.
 *
 * - les champs sont **préremplis** par la source préconfigurée (`profils.js`, remplacé à
 *   l'empaquetage par `secrets.local/profils.js`, hors dépôt) : rien à ressaisir à la télécommande ;
 * - « Tester la source » affiche le verdict réel (`Active`/`Expired`) et la limite de connexions ;
 * - « Importer (live) » suit la progression par abonnement (§15.4) et affiche le nombre d'entrées ;
 * - le consentement « HTTP clair » (§8.2) est une case explicite : un portail `http://` est refusé
 *   tant qu'elle n'est pas cochée, et le service dit **quel hôte** confirmer ;
 * - le diagnostic local montre ce que le service voit de son côté (`db.ok`, index, racines, chemin
 *   du pont LS2) — c'est le repère de la phase 0A.
 */

import React from 'react';
import {Panel} from '@enact/sandstone/Panels';
import BodyText from '@enact/sandstone/BodyText';
import Button from '@enact/sandstone/Button';
import CheckboxItem from '@enact/sandstone/CheckboxItem';
import Input from '@enact/sandstone/Input';
import ProgressBar from '@enact/sandstone/ProgressBar';
import {Scroller} from '@enact/sandstone/Scroller';

import {useApp} from '../App/AppContexte';
import service from '../services/service';
import ls2 from '../services/ls2';
import css from './Reglages.module.less';

const PHASES = {
	idle: 'aucun import en cours',
	downloading: 'téléchargement',
	parsing: 'analyse',
	writing: 'écriture de l’index',
	validating: 'vérification',
	swapping: 'bascule',
	done: 'terminé',
	failed: 'échec',
	cancelled: 'annulé'
};

/** Un champ du profil : libellé nommant la source, valeur préremplie, écriture par `majProfil`. */
function Champ({champ, libelle, valeur, type, majProfil}) {
	const changer = React.useCallback((evenement) => majProfil({[champ]: evenement.value}), [champ, majProfil]);
	return (
		<div className={css.champ}>
			<BodyText className={css.petit}>{libelle}</BodyText>
			<Input type={type} value={valeur} onChange={changer} />
		</div>
	);
}

function Reglages() {
	const {profil, majProfil, signaler, diagnostic, rafraichirDiagnostic} = useApp();
	const [verdict, setVerdict] = React.useState(null);
	const [progression, setProgression] = React.useState(null);
	const [journal, setJournal] = React.useState([]);
	const fluxRef = React.useRef(null);

	const tracer = React.useCallback(
		(texte, type) => {
			setJournal((lignes) =>
				lignes.slice(-6).concat([{texte, type: type || 'info', cle: Date.now() + ':' + lignes.length}])
			);
			if (type === 'erreur') signaler(texte, 'erreur');
		},
		[signaler]
	);

	const changerSource = React.useCallback(() => {
		const liste = profil.sources || [];
		if (liste.length === 0) return;
		const choix = (profil.choix + 1) % liste.length;
		const source = liste[choix];
		majProfil({
			choix,
			profilId: source.id || profil.profilId,
			nom: source.nom || source.url,
			url: source.url,
			username: source.username || '',
			password: source.password || '',
			insecureHttp: String(source.url || '').indexOf('http://') === 0
		});
	}, [profil, majProfil]);

	const tester = React.useCallback(() => {
		setVerdict(null);
		tracer('test de la source : ' + profil.url);
		service
			.testProfile({
				profileId: profil.profilId,
				baseUrl: profil.url,
				username: profil.username,
				password: profil.password,
				insecureHttp: profil.insecureHttp
			})
			.then((resultat) => {
				setVerdict(resultat);
				const donnees = resultat.data || {};
				if (resultat.ok) {
					const compte = donnees.account || {};
					tracer(
						'source acceptée — état ' +
							(compte.status || 'inconnu') +
							', ' +
							(donnees.warnings || []).length +
							' avertissement(s)'
					);
				} else {
					tracer('source refusée : ' + service.messageDe(resultat), 'erreur');
				}
			})
			.catch((erreur) => tracer('source : ' + erreur.message, 'erreur'));
	}, [profil, tracer]);

	/** Suit l'import jusqu'à la phase finale, puis rafraîchit le diagnostic local. */
	const surveiller = React.useCallback(
		(jobId) => {
			let tours = 0;
			const tic = () => {
				tours += 1;
				service.getImportJob(jobId).then((resultat) => {
					const job = resultat.data || {};
					setProgression({phase: job.phase || 'inconnue', entries: job.entriesRead || 0});
					if (job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled') {
						const avertissements = (job.warnings || []).length;
						tracer(
							'import ' +
								job.phase +
								' — ' +
								(job.entriesRead || 0) +
								' entrée(s)' +
								(avertissements ? ' (' + avertissements + ' avertissement(s))' : ''),
							job.phase === 'done' ? 'info' : 'erreur'
						);
						rafraichirDiagnostic();
						return;
					}
					if (tours < 600) window.setTimeout(tic, 500);
				});
			};
			window.setTimeout(tic, 500);
		},
		[tracer, rafraichirDiagnostic]
	);

	const importer = React.useCallback(() => {
		tracer('import live demandé');
		const flux = service.importerPlaylist(
			{
				profileId: profil.profilId,
				baseUrl: profil.url,
				username: profil.username,
				password: profil.password,
				contentType: 'live',
				insecureHttp: profil.insecureHttp,
				persistSecrets: false
			},
			(etape) => {
				const job = (etape.data && etape.data.job) || {};
				setProgression({phase: job.phase || 'downloading', entries: job.entriesRead || 0});
			}
		);
		fluxRef.current = flux;
		flux.depart
			.then((resultat) => {
				if (!resultat.ok) {
					tracer('import refusé : ' + service.messageDe(resultat), 'erreur');
					return;
				}
				const jobId = resultat.data && resultat.data.jobId;
				tracer('import lancé : ' + jobId);
				if (resultat.data && resultat.data.profilCree) tracer('profil créé par cet import');
				surveiller(jobId);
			})
			.catch((erreur) => tracer('import : ' + erreur.message, 'erreur'));
	}, [profil, tracer, surveiller]);

	const annulerImport = React.useCallback(() => {
		if (fluxRef.current && fluxRef.current.annuler) fluxRef.current.annuler();
		tracer('annulation demandée');
	}, [tracer]);

	/** La page de diagnostic reste le poste de controle du socle (0A), meme si l'interface demarre. */
	const ouvrirDiagnostic = React.useCallback(() => {
		window.location.href = 'diagnostic.html';
	}, []);

	const basculerHttpClair = React.useCallback(() => {
		majProfil({insecureHttp: !profil.insecureHttp});
	}, [profil.insecureHttp, majProfil]);

	const listeSources = profil.sources || [];
	const etiquettes = profil.etiquettes || {};

	return (
		<Panel className={css.reglages}>
			<Scroller className={css.defilement} focusableScrollbar>
				<div className={css.colonne}>
					<div className={css.bloc}>
						<BodyText className={css.titre}>Source</BodyText>
						{listeSources.length > 0 ? (
							<div className={css.rang}>
								<Button onClick={changerSource}>
									{listeSources.length > 1 ? 'Changer de source' : 'Source préconfigurée'}
								</Button>
								<BodyText className={css.petit}>{profil.nom}</BodyText>
							</div>
						) : (
							<BodyText className={css.petit}>
								Aucune source préconfigurée : saisir les champs ci-dessous.
							</BodyText>
						)}

						<Champ
							champ="profilId"
							libelle={etiquettes.profil || 'Identifiant de profil'}
							valeur={profil.profilId}
							majProfil={majProfil}
						/>
						<Champ
							champ="url"
							libelle={etiquettes.url || 'Adresse du portail'}
							valeur={profil.url}
							majProfil={majProfil}
						/>
						<Champ
							champ="username"
							libelle={etiquettes.utilisateur || "Nom d'utilisateur"}
							valeur={profil.username}
							majProfil={majProfil}
						/>
						<Champ
							champ="password"
							libelle={etiquettes.motdepasse || 'Mot de passe'}
							valeur={profil.password}
							type="password"
							majProfil={majProfil}
						/>

						<CheckboxItem selected={profil.insecureHttp === true} onToggle={basculerHttpClair}>
							Portail en HTTP clair : j&apos;autorise (avertissement une seule fois par hôte)
						</CheckboxItem>

						<div className={css.rang}>
							<Button className={css.principal} onClick={tester}>
								Tester la source
							</Button>
							<Button onClick={importer}>Importer (live)</Button>
							<Button onClick={annulerImport}>Annuler l&apos;import</Button>
						</div>

						{verdict ? (
							<BodyText className={css.petit}>
								{verdict.ok
									? 'Source acceptée — état ' +
									  ((verdict.data && verdict.data.account && verdict.data.account.status) || 'inconnu')
									: 'Source refusée : ' + service.messageDe(verdict)}
							</BodyText>
						) : null}

						{progression ? (
							<div className={css.progression}>
								<ProgressBar backgroundProgress={0.2} progress={progression.phase === 'done' ? 1 : 0.5} />
								<BodyText className={css.petit}>
									{PHASES[progression.phase] || progression.phase} — {progression.entries} entrée(s)
								</BodyText>
							</div>
						) : null}
					</div>

					<div className={css.bloc}>
						<BodyText className={css.titre}>Diagnostic local</BodyText>
						<div className={css.rang}>
							<Button onClick={rafraichirDiagnostic}>Rafraîchir</Button>
							<Button onClick={ouvrirDiagnostic}>Page de diagnostic (0A)</Button>
						</div>
						<BodyText className={css.mono}>pont LS2 : {ls2.chemin()}</BodyText>
						{diagnostic ? (
							<BodyText className={css.mono}>
								{diagnostic.ok
									? 'service : node ' +
									  ((diagnostic.data && diagnostic.data.runtime && diagnostic.data.runtime.node) || '?') +
									  ' · base ' +
									  (diagnostic.data && diagnostic.data.db && diagnostic.data.db.ok ? 'accessible' : 'inaccessible') +
									  ' · index ' +
									  ((diagnostic.data && diagnostic.data.indexes && diagnostic.data.indexes.length) || 0)
									: 'diagnostic indisponible : ' + service.messageDe(diagnostic)}
							</BodyText>
						) : (
							<BodyText className={css.petit}>en cours…</BodyText>
						)}
						{diagnostic && diagnostic.ok && diagnostic.data && diagnostic.data.indexes
							? diagnostic.data.indexes.map((index) => (
									<BodyText key={index.profileId + index.contentType} className={css.mono}>
										{index.contentType} : {index.entryCount} entrée(s), version {index.indexVersion},{' '}
										{index.state}
									</BodyText>
							  ))
							: null}
					</div>

					<div className={css.bloc}>
						<BodyText className={css.titre}>Journal</BodyText>
						{journal.length === 0 ? <BodyText className={css.petit}>aucun évènement</BodyText> : null}
						{journal.map((ligne) => (
							<BodyText key={ligne.cle} className={ligne.type === 'erreur' ? css.ligneErreur : css.mono}>
								{ligne.texte}
							</BodyText>
						))}
					</div>
				</div>
			</Scroller>
		</Panel>
	);
}

export default Reglages;
