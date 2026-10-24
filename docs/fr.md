# Ruuvi Gateway

**Connecteur non officiel, sans lien avec Ruuvi.** Il amène dans Gladys les
capteurs **RuuviTag** qu'entend votre **Ruuvi Gateway**, lus par l'API HTTP
locale de la passerelle, sur votre propre réseau (sans cloud).

> **Cette intégration n'a jamais été testée avec une vraie passerelle.** Elle
> suit la documentation officielle de Ruuvi
> ([docs.ruuvi.com](https://docs.ruuvi.com)) et ses trames de test publiées.
> Merci de signaler ce que vous observez sur le forum Gladys.

## Ce qu'il faut

- Une **Ruuvi Gateway** sur le même réseau local que Gladys, avec une adresse
  fixe (à régler dans votre box). La passerelle écoute les capteurs en
  Bluetooth et les relaie ; cette intégration n'utilise pas le Bluetooth (une
  intégration Gladys tourne dans un conteneur sans Bluetooth).
- L'**accès en lecture seule par clé d'API** activé : ouvrez les pages de
  configuration de la passerelle dans un navigateur
  (`http://<adresse de la passerelle>`), allez dans **Paramètres d'accès**
  (Access settings), activez l'accès en lecture seule par clé d'API
  (bearer) et copiez cette clé. C'est le « mode interrogation » (polling
  mode) de la documentation Ruuvi
  ([polling mode](https://docs.ruuvi.com/ruuvi-gateway-firmware/examples/polling-mode)).
  Une passerelle qui autorise le réseau local sans mot de passe fonctionne
  sans clé.

## Ce que vous obtenez

Un appareil Gladys par capteur, nommé « Ruuvi » suivi des quatre derniers
caractères de son adresse MAC (comme dans les applications Ruuvi ; renommez-le
à la création) :

| Fonction            | Unité                | Remarques                                                        |
| ------------------- | -------------------- | ---------------------------------------------------------------- |
| Temperature         | °C                   |                                                                  |
| Humidity            | %                    |                                                                  |
| Pressure            | hPa                  |                                                                  |
| Motion              | aucune (0 ou 1)      | 1 quand le capteur a senti un mouvement depuis sa mesure d'avant |
| Battery voltage (V) | aucune (dans le nom) | environ 3 V neuve ; changez la pile sous environ 2,5 V           |
| Signal (dBm)        | aucune (dans le nom) | le signal Bluetooth entre le capteur et la passerelle            |

- **Mouvement** (Motion) : le capteur compte les mouvements qu'il ressent
  (compteur de mouvements de la trame). À chaque lecture, Motion vaut 1
  quand le compteur a bougé depuis la mesure précédente du capteur, 0 sinon.
  Il faut deux mesures à la suite, à moins d'une heure d'écart : la première
  mesure après un démarrage ne donne pas de valeur de mouvement. Un capteur
  n'envoie son compteur que dans les formats RAWv2 et Cut-RAWv2.
- Gladys n'a pas d'unité pour une tension ni pour un signal en dBm dans ces
  catégories : ces deux valeurs sont sans unité, l'unité n'est écrite que
  dans leur nom.
- Une valeur que le capteur marque « non disponible » dans sa trame (0x8000,
  0xFFFF et semblables), ou hors de la plage de la fonction, est laissée de
  côté, jamais remplacée par une supposition.
- Les noms des fonctions sont en anglais ; renommez-les à la création si vous
  le souhaitez.

### Formats de données

L'intégration décode elle-même les trames (`GET /history?decode=false`),
d'après les pages de formats de Ruuvi :

- **5 (RAWv2)**, le format des RuuviTag depuis 2019 :
  [format 5](https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-5-rawv2) ;
- **C5 (Cut-RAWv2)**, RAWv2 sans l'accélération :
  [format C5](https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-c5-rawv2) ;
- **3 (RAWv1)**, l'ancien format (sans numéro de mesure ni compteur de
  mouvements) :
  [format 3](https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-3-rawv1).

Les formats de Ruuvi Air (6 et E1), le format 8 et les formats URL ne sont
pas décodés : le statut les compte (« trame(s) Ruuvi non décodée(s) »). Les
balises d'autres marques relayées par la passerelle sont ignorées.

## Installation

1. Installez l'intégration depuis le catalogue Gladys (Gladys 5.1 ou plus
   récent).
2. Dans l'écran **Configuration**, saisissez l'**adresse de la passerelle**
   (par exemple `192.168.1.50`, avec `:port` s'il n'est pas 80) et la **clé
   d'API en lecture seule**.
3. Cliquez sur **Tester la passerelle** : le message affiche les principales
   valeurs de chaque capteur.
4. Ouvrez l'onglet **Découverte** et ajoutez les appareils. Leurs valeurs
   arrivent dès leur création.

## Configuration

- **Adresse de la passerelle** : une adresse IP ou un nom d'hôte, avec un
  port facultatif ; `http://` devant est accepté, `https://` aussi si vous
  placez la passerelle derrière un proxy inverse avec un certificat valide.
  Un chemin, un nom d'utilisateur, une espace, une adresse de multidiffusion
  ou de diffusion sont refusés aussitôt (« non valide ») et rien n'est
  envoyé.
- **Clé d'API en lecture seule** : gardée par Gladys dans sa base (en clair,
  comme tout champ secret de Gladys) et jamais réaffichée dans l'écran de
  configuration. Elle n'est envoyée qu'à la passerelle, dans l'en-tête
  `Authorization: Bearer` de chaque lecture, jamais dans une URL, un
  journal, un statut ni sous `/data`. **La passerelle parle HTTP en clair
  sur le réseau local**
  ([ports ouverts](https://docs.ruuvi.com/ruuvi-gateway-firmware/gw-open-ports-services)) :
  la clé traverse votre réseau telle quelle ; utilisez donc la clé en
  lecture seule (jamais celle en lecture-écriture), sur un réseau de
  confiance. Une clé qui contient une espace ou un caractère qui n'est pas
  de l'ASCII imprimable est refusée aussitôt, jamais envoyée ni réaffichée.
- **Intervalle de lecture** : 2 minutes par défaut, de 1 à 60.

## À quel rythme la passerelle est lue

- À chaque intervalle, **une requête** : `GET /history?decode=false`, la
  dernière trame de chaque capteur entendu par la passerelle. Rien n'est
  jamais écrit sur la passerelle.
- **Jamais plus vite que l'intervalle**, compté depuis la dernière lecture :
  ni par le bouton de test, ni par une reconnexion à Gladys, une
  configuration enregistrée, l'onglet Découverte ou un redémarrage du
  conteneur. Seule une autre adresse ou une autre clé est essayée aussitôt.
  Avant la fin de l'intervalle, le bouton de test affiche les dernières
  valeurs et l'heure de la prochaine lecture possible.
- Une passerelle qui ne répond pas est réessayée à l'intervalle suivant.
- Quand la passerelle répond **429 ou 5xx**, elle est laissée tranquille le
  délai `Retry-After` donné, sinon 5 minutes, puis 10, 20… ; toujours entre
  1 minute et 6 heures, y compris après un redémarrage.
- Quand la passerelle **refuse la clé** (401 ou 403), ou renvoie vers sa page
  de connexion (une redirection : une clé est nécessaire), les lectures
  s'arrêtent **définitivement** et le statut le dit : aucun nouvel essai de
  lui-même, même après un redémarrage. Changez l'adresse ou la clé (essayée
  aussitôt), ou appuyez sur le bouton de test une fois l'intervalle écoulé
  (un essai ; l'arrêt n'est levé que s'il réussit). Enregistrer la
  configuration sans la changer ne lève jamais l'arrêt.

## Quelles valeurs arrivent dans Gladys

- Une mesure est reconnue par son **numéro de mesure** (le numéro de séquence
  de la trame, RAWv2 et Cut-RAWv2), sinon par l'instant où la passerelle l'a
  entendue (RAWv1), sinon par la trame elle-même. La passerelle entend
  plusieurs fois la même mesure : elle est remise à Gladys **une seule
  fois**. La marque de la dernière mesure remise est gardée sous `/data`
  (écrite aussitôt par un arrêt propre) : un redémarrage ne la renvoie pas.
- Ainsi un capteur qui **cesse de mesurer** n'envoie plus rien, même si la
  passerelle entend encore sa dernière trame : ni ses mesures ni son signal,
  envoyés seulement avec une nouvelle mesure. Après une heure sans nouvelle
  mesure, le statut l'indique « pas de mesure récente ».
- L'âge d'une mesure est compté sur l'**horloge de la passerelle** : de
  l'instant où elle a entendu cette mesure pour la première fois à l'instant
  de sa réponse (deux instants donnés par la passerelle) ; une horloge de
  Gladys décalée ne la fait donc jamais paraître plus vieille ou plus
  récente. Sans ces instants, l'âge est compté depuis la première fois que
  l'intégration a vu la mesure.
- Une nouvelle mesure de 5 minutes au plus (ou l'intervalle + 2 minutes) est
  envoyée comme valeur actuelle ; plus ancienne, jusqu'à une heure, elle est
  envoyée **datée** (Gladys l'enregistre à son heure réelle et aucune scène
  ne se déclenche) ; plus vieille qu'une heure, jamais. Une trame en avance
  de plus de 5 minutes sur l'horloge de la passerelle est ignorée, de même
  qu'une trame dont l'adresse MAC n'est pas celle sous laquelle la
  passerelle l'a rangée.
- Au plus **250 valeurs par minute** sont envoyées à Gladys (le cœur en
  accepte 300) : avec beaucoup de capteurs, le reste suit à la minute
  suivante. Une valeur inchangée n'est pas renvoyée (sauf toutes les 30
  minutes).

## Ce qui est gardé sous `/data`

L'instant de la dernière lecture, la pause, le refus, l'adresse MAC de la
passerelle et les capteurs rencontrés (adresse MAC, mesures, marque de la
dernière mesure remise à Gladys, dernière fois entendu : rien de secret)
survivent à une reconnexion et à un redémarrage du conteneur. L'instant d'une
lecture est écrit avant le départ de sa requête, et le fichier est écrit au
plus une fois par minute, sauf pour une pause, un refus ou un nouveau capteur
(écrits aussitôt). La clé n'est jamais écrite : tant qu'elle est refusée, le
fichier ne garde qu'un repère de 8 bits d'une empreinte salée de l'adresse et
de la clé (1 clé sur 256 donne le même repère : rien qui permette de
retrouver la clé), pour qu'après un redémarrage une autre clé soit essayée
aussitôt.

Au plus 50 capteurs sont lus ; une réponse de plus de 1 Mo, ou plus lente que
10 secondes, est abandonnée. Un capteur ni entendu depuis une semaine ni créé
dans Gladys (celui d'un voisin, de passage) quitte la liste de Découverte.

## Identifiants externes

`ext:ruuvi-gateway:tag:<MAC>`, l'adresse MAC du capteur telle que la
passerelle la donne, en 12 caractères hexadécimaux minuscules sans séparateur
(`C6:A5:B9:E0:AD:06` donne `c6a5b9e0ad06`), puis `:<fonction>`
(`temperature`, `humidity`, `pressure`, `motion`, `battery_voltage`,
`signal`). Ces identifiants ne changent jamais.

## Dépannage

- **« accès refusé »** : vérifiez la clé d'API en lecture seule sur la page
  Paramètres d'accès de la passerelle, puis changez-la dans la configuration,
  ou appuyez sur le bouton de test.
- **« réponse qui n'est pas celle d'une Ruuvi Gateway »** : l'adresse désigne
  un autre appareil, ou le micrologiciel de la passerelle est trop ancien
  pour le mode interrogation (mettez-le à jour depuis ses pages de
  configuration).
- **« pas de mesure récente »** : le capteur n'a pas envoyé de nouvelle
  mesure depuis une heure (hors de portée, pile vide, filtre de la
  passerelle).
- **« trame(s) Ruuvi non décodée(s) »** : un Ruuvi Air ou un capteur dans un
  format que cette intégration ne décode pas.
- Journaux : le niveau se règle avec la variable `LOG_LEVEL`.

## Vie privée

L'intégration ne parle qu'à votre passerelle, sur votre réseau. De ses
réponses, elle ne garde que l'adresse MAC et les mesures de chaque capteur,
et l'adresse MAC de la passerelle ; les coordonnées GPS que la passerelle peut
envoyer ne sont jamais lues.

## Crédits

Écrite d'après la documentation développeur de Ruuvi
([docs.ruuvi.com](https://docs.ruuvi.com), dépôt
[ruuvi/docs](https://github.com/ruuvi/docs)) : l'API locale de la passerelle
et les formats de données des capteurs. Aucun code d'un autre projet n'est
porté ; les pages utilisées sont listées dans `THIRD_PARTY_NOTICES.md`.
Ruuvi, RuuviTag et Ruuvi Gateway sont des marques de Ruuvi Innovations Ltd ;
ce connecteur est libre et non officiel.
