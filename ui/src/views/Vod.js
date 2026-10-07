'use strict';

/**
 * Films — **incrément V1-B**. L'écran existe et le dit : aucun catalogue, aucun compteur, aucune
 * grille vide qui ferait croire à un défaut de chargement (§1.4).
 */

import React from 'react';
import {Panel} from '@enact/sandstone/Panels';
import BodyText from '@enact/sandstone/BodyText';

import css from './Vod.module.less';

function Vod() {
  return (
    <Panel className={css.ecran}>
      <BodyText className={css.texte}>Films : livré à l&apos;incrément V1-B (grille, fiche, recherche indexée).</BodyText>
      <BodyText className={css.texte}>
        Le service indexe déjà ce contenu : « Importer (live) » puis, à l&apos;incrément suivant, l&apos;import
        et la grille Films.
      </BodyText>
    </Panel>
  );
}

export default Vod;
