'use strict';

/**
 * Séries — **incrément V1-C**. L'écran existe et le dit : aucun catalogue, aucun compteur, aucune
 * grille vide qui ferait croire à un défaut de chargement (§1.4).
 */

import React from 'react';
import {Panel} from '@enact/sandstone/Panels';
import BodyText from '@enact/sandstone/BodyText';

import css from './Series.module.less';

function Vod() {
  return (
    <Panel className={css.ecran}>
      <BodyText className={css.texte}>Séries : livré à l&apos;incrément V1-C (fiche série, saisons, épisodes, recherche sur les titres).</BodyText>
      <BodyText className={css.texte}>
        Le service indexe déjà ce contenu : « Importer (live) » puis, à l&apos;incrément suivant, les écrans
        Séries, à l&apos;incrément V1-C.
      </BodyText>
    </Panel>
  );
}

export default Vod;
