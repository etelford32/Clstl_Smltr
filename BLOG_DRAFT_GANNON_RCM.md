# BLOG DRAFT — "The index that lied: replaying the Gannon superstorm with a ring current"

> Draft for review. Three language versions: EN / ES / FR. Numbers are from
> the 2026-07-04/05 GM+IE+IM(RCM2) hindcasts and the joint two-event fit
> (`MHD_DENSITY_PHASE0_RESULTS.md`) — all final, gate PASSED at +48 %.
> Target: flat `*.html` page at repo root once approved (per CLAUDE.md §8).

---

## 🇬🇧 English

### The index that lied: replaying the Gannon superstorm with a ring current

On May 10, 2024, the strongest geomagnetic storm in two decades hit Earth.
Auroras reached Mexico. Satellite operators watched their spacecraft sink
into suddenly-thickened air. And the index the whole industry uses to model
that air — the planetary Ap index — quietly stopped telling the truth.

Ap has a ceiling. The scale tops out at 400, a design decision inherited
from the 1930s Kp network. For roughly 24 hours during the Gannon storm, Ap
sat **pinned at exactly 400** — not because the magnetosphere stopped getting
more disturbed, but because the ruler ran out of markings. Every empirical
density model driven by Ap (NRLMSIS included) was flying blind above the
clamp, and the drag forecasts derived from them inherited the lie.

This is the same failure family that cost SpaceX 38 Starlink satellites in
February 2022 — an event where the models' underestimate of storm-time
density turned a routine insertion into a mass reentry. Gannon is that
problem at ten times the energy.

**What we did.** We replayed the full 72-hour storm through a coupled
physics stack — BATS-R-US global magnetohydrodynamics, the Ridley ionosphere
solver, and (new to this run) the **RCM ring-current model** — driven by
nothing but real L1 solar-wind measurements, the data a forecaster would
actually have in real time. The whole simulation ran on a single
Apple-Silicon desktop in 13.4 hours: 1.15 million timesteps, ten MPI ranks,
one Docker image. Physics that used to demand a cluster now fits under a
desk.

**What the physics said.** The simulation's polar-cap potential peaked at
307 kV, and the pseudo-Ap we regress from it climbed to **Ap\* = 524** while
the official index sat clamped at 400. The magnetosphere kept going where
the index could not follow — that gap is invisible to every Ap-driven model
on the market.

**Does it help?** Scored against real GRACE-FO and Swarm-C accelerometer
densities with NRLMSIS as the baseline: in the *operational* regime — where
the competition is the Ap you actually have at forecast time, not the
definitive value published weeks later — the physics-derived Ap surrogate
alone cuts storm-time density error by **23%**. And when the same real-time
drivers power a density model with the thermosphere's true heating-cooling
memory (a ~5-hour relaxation the empirical models lack), the improvement
reaches **48%** — clearing the program's 25% validation gate. We then
replayed February 2022 — the Starlink-killer storm — through the same
pipeline and fit both events jointly: the coefficients barely moved.
The physics transfers across storms; it isn't tuned to one lucky event.

**The honest parts.** Two findings we're publishing because trust is the
product: (1) an earlier internal skill number (10.3%) turned out to be scored
against a fallback atmosphere rather than real NRLMSIS — the honest baseline
is harder to beat, and we say so; (2) the single biggest skill gain came not
from more physics but from refusing to let the saturated Ap bins poison the
regression — you cannot fit what the ruler cannot measure.

**Why it matters.** Every LEO operator budgets fuel and collision-avoidance
margin against a density forecast. When the driving index saturates exactly
when drag is most violent, those margins are fiction. A physics pipeline
that keeps measuring where the index clips — running on hardware any
operations room can afford — is the difference between "the model said 400"
and knowing it was really 524.

*The full run log, fits, and residual reports are in the ParkersPhysics
repository; the interactive storm replay is at parkersphysics.com.*

---

## 🇪🇸 Español

### El índice que mintió: recreando la supertormenta de Gannon con corriente de anillo

El 10 de mayo de 2024, la tormenta geomagnética más intensa en dos décadas
golpeó la Tierra. Las auroras llegaron hasta México. Los operadores de
satélites vieron a sus naves hundirse en un aire repentinamente más denso. Y
el índice que toda la industria usa para modelar ese aire — el índice
planetario Ap — dejó de decir la verdad, en silencio.

Ap tiene un techo. La escala termina en 400, una decisión de diseño heredada
de la red Kp de los años treinta. Durante unas 24 horas de la tormenta de
Gannon, Ap quedó **clavado exactamente en 400** — no porque la magnetosfera
dejara de perturbarse, sino porque a la regla se le acabaron las marcas.
Todos los modelos empíricos de densidad que dependen de Ap (incluido
NRLMSIS) volaban a ciegas por encima del tope, y los pronósticos de
arrastre heredaron la mentira.

Es la misma familia de fallos que le costó a SpaceX 38 satélites Starlink en
febrero de 2022, cuando la subestimación de la densidad durante la tormenta
convirtió una inserción rutinaria en una reentrada masiva. Gannon es ese
mismo problema con diez veces más energía.

**Qué hicimos.** Recreamos las 72 horas completas de la tormenta con una
cadena de física acoplada — magnetohidrodinámica global BATS-R-US, el
resolvedor ionosférico de Ridley y, novedad de esta ejecución, el **modelo de
corriente de anillo RCM** — alimentada únicamente con mediciones reales del
viento solar en L1: los datos que un pronosticador tendría de verdad en
tiempo real. Toda la simulación corrió en un solo escritorio Apple Silicon
en 13,4 horas: 1,15 millones de pasos, diez procesos MPI, una imagen Docker.
Física que antes exigía un clúster ahora cabe bajo una mesa.

**Qué dijo la física.** El potencial de casquete polar simulado alcanzó
307 kV, y el pseudo-Ap que ajustamos a partir de él subió hasta
**Ap\* = 524** mientras el índice oficial seguía clavado en 400. La
magnetosfera siguió avanzando donde el índice no podía seguirla — y esa
brecha es invisible para todos los modelos del mercado que dependen de Ap.

**¿Sirve de algo?** Evaluado contra densidades reales de los acelerómetros
GRACE-FO y Swarm-C con NRLMSIS como referencia: en el régimen *operacional*
— donde la competencia es el Ap disponible en el momento del pronóstico, no
el valor definitivo publicado semanas después — el sustituto de Ap derivado
de la física reduce por sí solo el error de densidad en tormenta un
**23 %**. Y cuando esos mismos datos en tiempo real alimentan un modelo de
densidad con la verdadera memoria térmica de la termosfera (una relajación
de ~5 horas que los modelos empíricos no tienen), la mejora llega al
**48 %** — superando la meta de validación del 25 %. Después recreamos
febrero de 2022 — la tormenta que mató a los Starlink — con la misma cadena
y ajustamos ambos eventos conjuntamente: los coeficientes apenas se
movieron. La física se transfiere entre tormentas; no está calibrada a un
evento afortunado.

**La parte honesta.** Publicamos dos hallazgos porque la confianza es el
producto: (1) una métrica interna anterior (10,3 %) resultó estar evaluada
contra una atmósfera de respaldo y no contra el NRLMSIS real — la referencia
honesta es más difícil de superar, y lo decimos; (2) la mayor ganancia no
vino de más física, sino de negarnos a que los tramos saturados de Ap
envenenaran la regresión: no se puede ajustar lo que la regla no puede medir.

**Por qué importa.** Todo operador en órbita baja presupuesta combustible y
márgenes de evasión contra un pronóstico de densidad. Cuando el índice que
lo alimenta se satura justo cuando el arrastre es más violento, esos
márgenes son ficción. Una cadena de física que sigue midiendo donde el
índice se recorta — y que corre en hardware al alcance de cualquier sala de
operaciones — es la diferencia entre "el modelo dijo 400" y saber que en
realidad eran 524.

*El registro completo de la ejecución, los ajustes y los informes de
residuos están en el repositorio de ParkersPhysics; la recreación
interactiva de la tormenta está en parkersphysics.com.*

---

## 🇫🇷 Français

### L'indice qui mentait : rejouer la supertempête de Gannon avec un courant annulaire

Le 10 mai 2024, la plus forte tempête géomagnétique en vingt ans a frappé la
Terre. Les aurores sont descendues jusqu'au Mexique. Les opérateurs de
satellites ont regardé leurs engins s'enfoncer dans un air soudainement
densifié. Et l'indice que toute l'industrie utilise pour modéliser cet air —
l'indice planétaire Ap — a cessé, en silence, de dire la vérité.

Ap possède un plafond. L'échelle s'arrête à 400, un choix de conception
hérité du réseau Kp des années 1930. Pendant environ 24 heures de la
tempête de Gannon, Ap est resté **bloqué à exactement 400** — non pas parce
que la magnétosphère avait cessé de se perturber, mais parce que la règle
n'avait plus de graduations. Tous les modèles empiriques de densité pilotés
par Ap (NRLMSIS compris) volaient à l'aveugle au-dessus du plafond, et les
prévisions de traînée en ont hérité le mensonge.

C'est la même famille de défaillances qui a coûté à SpaceX 38 satellites
Starlink en février 2022 — un événement où la sous-estimation de la densité
en tempête a transformé une insertion de routine en rentrée massive. Gannon,
c'est ce problème-là, avec dix fois plus d'énergie.

**Ce que nous avons fait.** Nous avons rejoué les 72 heures de la tempête à
travers une chaîne physique couplée — la magnétohydrodynamique globale
BATS-R-US, le solveur ionosphérique de Ridley et, nouveauté de cette
exécution, le **modèle de courant annulaire RCM** — pilotée uniquement par de
vraies mesures du vent solaire en L1 : les données dont un prévisionniste
disposerait réellement en temps réel. La simulation entière a tourné sur un
seul poste de travail Apple Silicon en 13,4 heures : 1,15 million de pas de
temps, dix rangs MPI, une image Docker. Une physique qui exigeait hier un
cluster tient aujourd'hui sous un bureau.

**Ce que la physique a dit.** Le potentiel de calotte polaire simulé a
culminé à 307 kV, et le pseudo-Ap que nous en régressons est monté à
**Ap\* = 524** pendant que l'indice officiel restait cloué à 400. La
magnétosphère a continué là où l'indice ne pouvait plus suivre — et cet
écart est invisible pour tous les modèles du marché pilotés par Ap.

**Est-ce que ça aide ?** Évalué contre les densités réelles des
accéléromètres GRACE-FO et Swarm-C, NRLMSIS servant de référence : dans le
régime *opérationnel* — où la concurrence est l'Ap dont on dispose vraiment
au moment de la prévision, et non la valeur définitive publiée des semaines
plus tard — le substitut d'Ap dérivé de la physique réduit à lui seul
l'erreur de densité en tempête de **23 %**. Et quand ces mêmes données
temps-réel alimentent un modèle de densité doté de la vraie mémoire
thermique de la thermosphère (une relaxation d'environ 5 heures que les
modèles empiriques n'ont pas), le gain atteint **48 %** — franchissant
l'objectif de validation de 25 %. Nous avons ensuite rejoué février 2022 —
la tempête qui a tué les Starlink — dans la même chaîne et ajusté les deux
événements conjointement : les coefficients ont à peine bougé. La physique
se transfère d'une tempête à l'autre ; elle n'est pas réglée sur un
événement chanceux.

**La part d'honnêteté.** Nous publions deux constats, parce que la confiance
est le produit : (1) un chiffre interne antérieur (10,3 %) s'est révélé
évalué contre une atmosphère de secours et non le vrai NRLMSIS — la
référence honnête est plus dure à battre, et nous le disons ; (2) le plus
grand gain n'est pas venu d'un supplément de physique, mais du refus de
laisser les créneaux d'Ap saturés empoisonner la régression : on ne peut pas
ajuster ce que la règle ne sait pas mesurer.

**Pourquoi c'est important.** Chaque opérateur en orbite basse budgète son
carburant et ses marges d'évitement sur une prévision de densité. Quand
l'indice qui la pilote sature précisément au moment où la traînée est la
plus violente, ces marges sont une fiction. Une chaîne physique qui continue
de mesurer là où l'indice écrête — sur du matériel à la portée de n'importe
quelle salle d'opérations — c'est la différence entre « le modèle disait
400 » et savoir qu'il fallait lire 524.

*Le journal complet de l'exécution, les ajustements et les rapports de
résidus sont dans le dépôt ParkersPhysics ; la reconstitution interactive de
la tempête est sur parkersphysics.com.*
