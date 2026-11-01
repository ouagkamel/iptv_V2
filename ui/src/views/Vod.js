'use strict';

/**
 * VOD — tranche autorisée de V1-B : catégories, grille virtualisée et fiche/lancement (§3.3).
 * La recherche, le saut alphabétique, les favoris, la reprise, l'EPG et les séries restent hors
 * périmètre. Les pages et les fiches proviennent uniquement de l'index local du service.
 */

import React from 'react';
import {Panel} from '@enact/sandstone/Panels';
import BodyText from '@enact/sandstone/BodyText';
import Button from '@enact/sandstone/Button';
import ImageItem from '@enact/sandstone/ImageItem';
import Item from '@enact/sandstone/Item';
import Popup from '@enact/sandstone/Popup';
import Spinner from '@enact/sandstone/Spinner';
import {VirtualGridList} from '@enact/sandstone/VirtualList';
import ri from '@enact/ui/resolution';

import {useApp} from '../App/AppContexte';
import service from '../services/service';
import vodUtils from '../services/vod-utils';
import css from './Vod.module.less';

const ETAT_INITIAL = {
  profileId: '',
  hasLoaded: false,
  categories: [],
  categoryId: '',
  films: [],
  cursor: null,
  totalKnown: null,
  approximate: false,
  loadingCategories: false,
  loadingPage: false,
  error: '',
  errorCode: ''
};

const FILM_CSS = {
  imageItem: css.film,
  image: css.filmPoster,
  caption: css.filmCaption,
  label: css.filmLabel
};

const POSTER_CSS = {
  imageItem: css.posterFiche,
  image: css.posterFicheImage
};

/** Carte de film virtualisée : le poster n'est demandé que pour les cellules rendues. */
function CarteFilm({film, onOuvrir, index, ...rest}) {
  const ouvrir = React.useCallback(() => onOuvrir(film), [film, onOuvrir]);
  const classe = rest.className ? rest.className + ' ' + css.elementGrille : css.elementGrille;
  return (
    <ImageItem
      {...rest}
      className={classe}
      css={FILM_CSS}
      data-index={index}
      src={vodUtils.urlAffiche(film.logoOrPosterUrl)}
      label={vodUtils.libelleSecondaire(film) || undefined}
      aria-label={film.title}
      onClick={ouvrir}
    >
      {film.title}
    </ImageItem>
  );
}

/** Une catégorie, annoncée active autrement que par la seule couleur. */
function LigneCategorie({categorie, active, onChoisir}) {
  const choisir = React.useCallback(() => onChoisir(categorie.id), [categorie.id, onChoisir]);
  const compteur = typeof categorie.count === 'number' ? ' (' + categorie.count + ')' : '';
  return (
    <Item
      className={active ? css.categorieActive : css.categorie}
      onClick={choisir}
      aria-current={active ? 'true' : undefined}
    >
      {categorie.name + compteur}
    </Item>
  );
}

function Vod() {
  const {profil, signaler, lancer, section, allerAuContenu, revisionVOD} = useApp();
  const [etat, setEtat] = React.useState(ETAT_INITIAL);
  const [fiche, setFiche] = React.useState(null);
  const etatRef = React.useRef(etat);
  etatRef.current = etat;

  // Invalident les réponses tardives après changement de catégorie/profil ou rafraîchissement.
  const generationRef = React.useRef(0);
  const detailRef = React.useRef(0);
  const pageEnCoursRef = React.useRef(false);
  const scrollToRef = React.useRef(null);
  const revisionObserveeRef = React.useRef(revisionVOD);

  const signalerEchec = React.useCallback(
    (resultat, quoi, generation) => {
      if (generation !== generationRef.current) return;
      const texte = service.messageDe(resultat) || 'bridge/unavailable — service indisponible';
      const code = resultat && resultat.error && resultat.error.code ? resultat.error.code : '';
      setEtat((precedent) => Object.assign({}, precedent, {loadingPage: false, loadingCategories: false, error: texte, errorCode: code}));
      signaler('catalogue VOD — ' + quoi + ' : ' + texte, 'erreur');
    },
    [signaler]
  );

  /** Charge une page bornée; VirtualGridList demandera la suivante près du bas de liste. */
  const chargerPage = React.useCallback(
    (categoryId, cursor, generation) => {
      const version = generation === undefined ? generationRef.current : generation;
      if (version !== generationRef.current || pageEnCoursRef.current) return;
      pageEnCoursRef.current = true;
      setEtat((precedent) => Object.assign({}, precedent, {loadingPage: true, error: '', errorCode: ''}));

      service
        .getPage({
          profileId: profil.profilId,
          contentType: 'vod',
          categoryId: categoryId,
          order: 'source',
          cursor: cursor
        })
        .then((resultat) => {
          if (version !== generationRef.current) return;
          if (!resultat.ok) {
            signalerEchec(resultat, 'films', version);
            return;
          }
          const page = resultat.data || {};
          const films = Array.isArray(page.items) ? page.items : [];
          setEtat((precedent) =>
            Object.assign({}, precedent, {
              films: cursor ? precedent.films.concat(films) : films,
              cursor: page.cursor || null,
              totalKnown: typeof page.totalKnown === 'number' ? page.totalKnown : precedent.totalKnown,
              approximate: page.approximate === true,
              loadingPage: false,
              error: '',
              errorCode: ''
            })
          );
        })
        .catch(() => {
          signalerEchec(
            {error: {code: 'bridge/unavailable', message: 'service indisponible'}},
            'films',
            version
          );
        })
        .then(() => {
          if (version === generationRef.current) pageEnCoursRef.current = false;
        });
    },
    [profil.profilId, signalerEchec]
  );

  /** Catégories déjà indexées : aucune requête fournisseur à l'ouverture de l'écran. */
  const chargerCategories = React.useCallback(() => {
    const profileId = profil.profilId || '';
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    pageEnCoursRef.current = false;
    detailRef.current += 1;
    setFiche(null);
    setEtat(Object.assign({}, ETAT_INITIAL, {profileId: profileId, hasLoaded: true, loadingCategories: true}));
    if (scrollToRef.current) scrollToRef.current({align: 'top', animate: false});

    if (!profileId) {
      setEtat(
        Object.assign({}, ETAT_INITIAL, {
          profileId: profileId,
          hasLoaded: true,
          error: 'profile/invalid — aucun profil actif',
          errorCode: 'profile/invalid'
        })
      );
      return;
    }

    service
      .getCategories(profileId, 'vod')
      .then((resultat) => {
        if (generation !== generationRef.current) return;
        if (!resultat.ok) {
          signalerEchec(resultat, 'catégories', generation);
          return;
        }
        const categories = (resultat.data && resultat.data.categories) || [];
        const premiere = categories.length ? categories[0].id : '';
        setEtat((precedent) =>
          Object.assign({}, precedent, {
            profileId: profileId,
            hasLoaded: true,
            categories: categories,
            categoryId: premiere,
            films: [],
            cursor: null,
            totalKnown: resultat.data && typeof resultat.data.total === 'number' ? resultat.data.total : null,
            approximate: false,
            loadingCategories: false,
            error: '',
            errorCode: ''
          })
        );
        if (premiere) chargerPage(premiere, null, generation);
      })
      .catch(() => {
        signalerEchec(
          {error: {code: 'bridge/unavailable', message: 'service indisponible'}},
          'catégories',
          generation
        );
      });
  }, [profil.profilId, chargerPage, signalerEchec]);

  // La vue n'est interrogée qu'à son ouverture. Si l'index manquait, retour depuis Réglages
  // après un import VOD relance automatiquement sa lecture; un catalogue déjà chargé est conservé.
  React.useEffect(() => {
    if (section !== 'vod') return;
    const courant = etatRef.current;
    const revisionChangee = revisionObserveeRef.current !== revisionVOD;
    revisionObserveeRef.current = revisionVOD;
    if (
      revisionChangee ||
      courant.profileId !== (profil.profilId || '') ||
      !courant.hasLoaded ||
      courant.errorCode === 'catalog/indexMissing' ||
      courant.errorCode === 'catalog/indexChanged'
    ) {
      chargerCategories();
    }
  }, [section, profil.profilId, revisionVOD, chargerCategories]);

  const choisirCategorie = React.useCallback(
    (categoryId) => {
      const courant = etatRef.current;
      if (!categoryId || categoryId === courant.categoryId) return;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      pageEnCoursRef.current = false;
      if (scrollToRef.current) scrollToRef.current({align: 'top', animate: false});
      setEtat((precedent) =>
        Object.assign({}, precedent, {
          categoryId: categoryId,
          films: [],
          cursor: null,
          totalKnown: null,
          approximate: false,
          loadingPage: true,
          error: '',
          errorCode: ''
        })
      );
      chargerPage(categoryId, null, generation);
    },
    [chargerPage]
  );

  const memoriserDefilement = React.useCallback((scrollTo) => {
    scrollToRef.current = scrollTo;
  }, []);

  /** Pagination à la demande en approchant de la dernière rangée visible. */
  const surArretDefilement = React.useCallback(
    (evenement) => {
      const courant = etatRef.current;
      const moreInfo = evenement && evenement.moreInfo;
      const dernierVisible = moreInfo && moreInfo.lastVisibleIndex;
      if (
        typeof dernierVisible !== 'number' ||
        dernierVisible < courant.films.length - 12 ||
        courant.loadingCategories ||
        !courant.cursor
      ) {
        return;
      }
      chargerPage(courant.categoryId, courant.cursor, generationRef.current);
    },
    [chargerPage]
  );

  const ouvrirFiche = React.useCallback(
    (film) => {
      const token = detailRef.current + 1;
      detailRef.current = token;
      setFiche({film: film, details: null, loading: true, error: ''});
      service
        .getDetails(profil.profilId, 'vod', film.ref)
        .then((resultat) => {
          if (token !== detailRef.current) return;
          if (!resultat.ok) {
            setFiche({film: film, details: null, loading: false, error: service.messageDe(resultat)});
            signaler('fiche VOD : ' + service.messageDe(resultat), 'erreur');
            return;
          }
          setFiche({film: film, details: resultat.data || {}, loading: false, error: ''});
        })
        .catch(() => {
          if (token !== detailRef.current) return;
          setFiche({film: film, details: null, loading: false, error: 'bridge/unavailable — fiche indisponible'});
          signaler('fiche VOD : bridge/unavailable — fiche indisponible', 'erreur');
        });
    },
    [profil.profilId, signaler]
  );

  const fermerFiche = React.useCallback(() => {
    detailRef.current += 1;
    setFiche(null);
  }, []);

  // Escape et Retour de la télécommande ferment d'abord la fiche, sans dépiler l'écran VOD.
  const ficheOuverte = Boolean(fiche);
  React.useEffect(() => {
    if (!ficheOuverte) return undefined;
    const surRetour = (evenement) => {
      if (evenement.keyCode !== 461 && evenement.keyCode !== 27) return;
      evenement.preventDefault();
      evenement.stopPropagation();
      if (evenement.stopImmediatePropagation) evenement.stopImmediatePropagation();
      fermerFiche();
    };
    window.addEventListener('keyup', surRetour, true);
    return () => window.removeEventListener('keyup', surRetour, true);
  }, [ficheOuverte, fermerFiche]);

  const lireFilm = React.useCallback(() => {
    if (!fiche || !fiche.film || fiche.film.playable !== true) return;
    const entree = fiche.film;
    detailRef.current += 1;
    setFiche(null);
    lancer({
      profilId: profil.profilId,
      contentType: 'vod',
      file: [{ref: entree.ref, titre: entree.title}],
      index: 0,
      titreFile: 'Films'
    });
  }, [fiche, lancer, profil.profilId]);

  const rendreFilm = React.useCallback(
    ({index, ...rest}) => {
      const film = etat.films[index];
      if (!film) return <Item {...rest} key={'vod-vide-' + index} disabled />;
      const cle = (film.ref && film.ref.providerId) || film.title + '-' + index;
      return <CarteFilm {...rest} key={cle} film={film} index={index} onOuvrir={ouvrirFiche} />;
    },
    [etat.films, ouvrirFiche]
  );

  const ouvrirReglages = React.useCallback(() => allerAuContenu('reglages'), [allerAuContenu]);
  const categorieActive = etat.categories.filter((categorie) => categorie.id === etat.categoryId)[0];
  const filmFiche = fiche ? Object.assign({}, fiche.film, fiche.details || {}) : null;
  const afficheFiche = filmFiche ? vodUtils.urlAffiche(filmFiche.logoOrPosterUrl) : '';
  const synopsis = filmFiche && (filmFiche.plot || filmFiche.summary);
  const titreCategorie = categorieActive ? categorieActive.name : '';
  const compteFilms = categorieActive && typeof categorieActive.count === 'number' ? categorieActive.count : etat.totalKnown;
  const vide = !etat.loadingCategories && !etat.loadingPage && etat.films.length === 0;

  return (
    <Panel className={css.ecran}>
      <div className={css.panneaux}>
        <div className={css.categories}>
          <BodyText className={css.enteteCategories}>Catégories VOD ({etat.categories.length})</BodyText>
          {etat.categories.map((categorie) => (
            <LigneCategorie
              key={categorie.id}
              categorie={categorie}
              active={categorie.id === etat.categoryId}
              onChoisir={choisirCategorie}
            />
          ))}
          {etat.categories.length === 0 && !etat.loadingCategories ? (
            <div className={css.messageVide}>
              <BodyText>
                {etat.error
                  ? 'Catalogue VOD indisponible : ' + etat.error
                  : 'Aucune catégorie VOD. Importez un catalogue VOD depuis Réglages.'}
              </BodyText>
              <Button onClick={ouvrirReglages}>Ouvrir Réglages</Button>
              <Button onClick={chargerCategories}>Réessayer</Button>
            </div>
          ) : null}
        </div>

        <div className={css.contenu}>
          <div className={css.enteteGrille}>
            <BodyText className={css.titreGrille}>
              {titreCategorie || 'Films'}
              {typeof compteFilms === 'number' ? ' — ' + compteFilms + ' film(s)' : ''}
            </BodyText>
            <div className={css.actionsEntete}>
              {etat.approximate ? <BodyText className={css.avertissement}>Indexation partielle</BodyText> : null}
              <Button onClick={chargerCategories} disabled={etat.loadingCategories || etat.loadingPage}>
                Actualiser
              </Button>
            </div>
          </div>

          <div className={css.zoneGrille}>
            {etat.loadingCategories || (etat.loadingPage && etat.films.length === 0) ? <Spinner /> : null}
            {vide && etat.categories.length > 0 ? (
              <BodyText className={css.messageVide}>
                {etat.error
                  ? 'Chargement impossible : ' + etat.error
                  : 'Aucun film dans cette catégorie.'}
              </BodyText>
            ) : null}
            {etat.error && etat.films.length > 0 ? <BodyText className={css.erreurPage}>{etat.error}</BodyText> : null}
            {etat.loadingPage && etat.films.length > 0 ? <BodyText className={css.chargementSuite}>Chargement…</BodyText> : null}
            {etat.films.length > 0 ? (
              <VirtualGridList
                itemRenderer={rendreFilm}
                itemSize={{minWidth: ri.scale(250), minHeight: ri.scale(340)}}
                spacing={ri.scale(12)}
                dataSize={etat.films.length}
                onScrollStop={surArretDefilement}
                cbScrollTo={memoriserDefilement}
                className={css.liste}
                verticalScrollbar="auto"
                role="list"
              />
            ) : null}
          </div>
        </div>
      </div>

      <Popup
        open={Boolean(fiche)}
        position="center"
        spotlightRestrict="self-only"
        onClose={fermerFiche}
        className={css.popup}
      >
        {fiche && filmFiche ? (
          <div className={css.fiche}>
            <div className={css.afficheFiche}>
              <ImageItem
                className={css.posterFiche}
                css={POSTER_CSS}
                src={afficheFiche}
                aria-label={filmFiche.title}
                disabled
              />
            </div>
            <div className={css.contenuFiche}>
              <BodyText className={css.titreFiche}>{filmFiche.title}</BodyText>
              {vodUtils.libelleSecondaire(filmFiche) ? (
                <BodyText className={css.metaFiche}>{vodUtils.libelleSecondaire(filmFiche)}</BodyText>
              ) : null}
              {fiche.loading ? <Spinner /> : null}
              {fiche.error ? <BodyText className={css.erreurFiche}>{fiche.error}</BodyText> : null}
              <BodyText className={css.synopsis}>
                {synopsis || (fiche.loading ? 'Chargement de la fiche…' : 'Aucun synopsis fourni.')}
              </BodyText>
              {fiche.film.playable !== true ? (
                <BodyText className={css.indisponible}>Lecture indisponible pour ce film.</BodyText>
              ) : null}
              <div className={css.actionsFiche}>
                <Button className={css.boutonLire} onClick={lireFilm} disabled={fiche.film.playable !== true}>
                  Lire
                </Button>
                <Button onClick={fermerFiche}>Retour</Button>
              </div>
            </div>
          </div>
        ) : null}
      </Popup>
    </Panel>
  );
}

export default Vod;
