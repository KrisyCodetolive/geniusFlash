// Carrousel des atouts : il défile seul, la carte active au centre et ses voisines inclinées sur les côtés,
// et le fond de la section prend la couleur de la carte active.

const AUTOPLAY_MS = 5000;
const SWIPE_THRESHOLD_PX = 40;

function setupShowcase(root: HTMLElement) {
  const cards = Array.from(root.querySelectorAll<HTMLElement>('.showcase-card'));
  const dotsBox = root.querySelector<HTMLElement>('.showcase-dots');
  const stage = root.querySelector<HTMLElement>('.showcase-stage');
  if (cards.length === 0 || !dotsBox || !stage) return;

  let active = 0;
  let timer: number | undefined;
  // Pause seulement pendant la navigation au clavier dans les points ; un clic de souris ne l’arrête pas.
  let paused = false;

  const dots = cards.map((card, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'showcase-dot';
    dot.setAttribute('aria-label', card.getAttribute('aria-label') ?? `Carte ${index + 1}`);
    dot.addEventListener('click', () => goTo(index, true));
    dotsBox.append(dot);
    return dot;
  });

  function render() {
    const count = cards.length;
    cards.forEach((card, index) => {
      // Distance la plus courte vers la carte active, en faisant le tour : le carrousel boucle.
      let offset = index - active;
      if (offset > count / 2) offset -= count;
      if (offset < -count / 2) offset += count;
      card.style.setProperty('--offset', String(offset));
      card.style.setProperty('--distance', String(Math.abs(offset)));
      card.dataset.position = offset === 0 ? 'center' : Math.abs(offset) === 1 ? 'side' : 'hidden';
      card.inert = offset !== 0;
    });
    dots.forEach((dot, index) => dot.setAttribute('aria-current', String(index === active)));
    root.style.setProperty('--tone', cards[active].dataset.tone ?? '');
  }

  function goTo(index: number, fromUser = false) {
    active = (index + cards.length) % cards.length;
    render();
    // Après une action de la personne, le défilement automatique reprend de zéro.
    if (fromUser) restart();
  }

  function stop() {
    window.clearInterval(timer);
    timer = undefined;
  }

  function restart() {
    stop();
    if (paused || document.hidden) return;
    timer = window.setInterval(() => goTo(active + 1), AUTOPLAY_MS);
  }

  dotsBox.addEventListener('focusin', (event) => {
    paused = (event.target as HTMLElement).matches(':focus-visible');
    restart();
  });
  dotsBox.addEventListener('focusout', () => {
    paused = false;
    restart();
  });

  // Une carte de côté se met au centre quand on clique dessus.
  cards.forEach((card, index) => {
    card.addEventListener('click', () => {
      if (index !== active) goTo(index, true);
    });
  });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') goTo(active - 1, true);
    if (event.key === 'ArrowRight') goTo(active + 1, true);
  });

  let swipeStartX: number | null = null;
  stage.addEventListener('pointerdown', (event) => {
    swipeStartX = event.clientX;
  });
  stage.addEventListener('pointerup', (event) => {
    if (swipeStartX === null) return;
    const deltaX = event.clientX - swipeStartX;
    swipeStartX = null;
    if (Math.abs(deltaX) >= SWIPE_THRESHOLD_PX) goTo(active + (deltaX < 0 ? 1 : -1), true);
  });

  // Onglet caché : inutile de tourner ; le défilement reprend au retour.
  document.addEventListener('visibilitychange', restart);

  dotsBox.hidden = false;
  root.classList.add('is-ready');
  render();
  restart();
}

document.querySelectorAll<HTMLElement>('[data-showcase]').forEach(setupShowcase);
