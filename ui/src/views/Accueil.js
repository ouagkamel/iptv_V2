'use strict';

/**
 * Accueil : **quatre cartes** (§4.3 « Accueil »), parcourables au D-pad. Films expose la tranche VOD
 * autorisée (grille + fiche); les fonctions VOD restantes et Séries ne sont pas annoncées comme livrées.
 */

import React from 'react';
import {Panel} from '@enact/sandstone/Panels';
import BodyText from '@enact/sandstone/BodyText';
import Button from '@enact/sandstone/Button';

import {useApp} from '../App/AppContexte';
import css from './Accueil.module.less';

const DESCRIPTIONS = {
	live: 'Chaînes du fournisseur, par catégorie',
	vod: 'Films — grille et fiches VOD (V1-B partiel)',
	series: 'Séries — incrément V1-C',
	reglages: 'Profil Xtream, import, diagnostic local'
};

/** Une carte : bouton + description, sans fonction anonyme dans les props JSX. */
function Carte({section, onOuvrir}) {
	const ouvrir = React.useCallback(() => onOuvrir(section.cle), [onOuvrir, section.cle]);
	return (
		<div className={css.carte}>
			<Button className={css.bouton} icon={section.icone} onClick={ouvrir} spotlightId={'carte-' + section.cle}>
				{section.titre}
			</Button>
			<BodyText className={css.description}>{DESCRIPTIONS[section.cle]}</BodyText>
		</div>
	);
}

function Accueil({sections}) {
	const {allerAuContenu} = useApp();
	return (
		<Panel className={css.accueil}>
			<div className={css.grille}>
				{sections.map((section) => (
					<Carte key={section.cle} section={section} onOuvrir={allerAuContenu} />
				))}
			</div>
		</Panel>
	);
}

export default Accueil;
