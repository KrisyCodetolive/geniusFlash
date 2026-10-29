import { icon, type IconName } from './icons';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

type InstallPlatform = 'ios' | 'android' | 'chromium-desktop' | 'macos-safari' | 'firefox-desktop' | 'other';
type Notify = (title: string, message: string, tone?: 'info' | 'success' | 'error') => void;
type InstallStep = { icon: IconName; html: string };

export function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform.toLowerCase().includes('mac') && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function detectInstallPlatform(): InstallPlatform {
  const userAgent = navigator.userAgent;
  if (isIosDevice()) return 'ios';
  if (/android/i.test(userAgent)) return 'android';
  if (/firefox/i.test(userAgent)) return 'firefox-desktop';
  const isChromium = /chrome|chromium|edg\//i.test(userAgent);
  if (isChromium) return 'chromium-desktop';
  if (/macintosh/i.test(userAgent) && /safari/i.test(userAgent)) return 'macos-safari';
  return 'other';
}

/**
 * Étapes affichées quand le navigateur ne propose pas sa fenêtre d’installation.
 * Sans HTTPS, l’installation complète est bloquée : on guide vers un raccourci qui s’ouvre comme une app.
 */
function installSteps(platform: InstallPlatform, secure: boolean): InstallStep[] {
  switch (platform) {
    case 'ios':
      return [
        { icon: 'share', html: 'Dans <strong>Safari</strong>, touchez le bouton <strong>Partager</strong> en bas de l’écran.' },
        { icon: 'addBox', html: 'Faites défiler puis choisissez <strong>« Sur l’écran d’accueil »</strong>.' },
        { icon: 'check', html: 'Touchez <strong>« Ajouter »</strong> : l’icône GeniusSend apparaît sur votre écran d’accueil.' }
      ];
    case 'android':
      return [
        { icon: 'menu', html: 'Ouvrez le menu <strong>⋮</strong> de Chrome, en haut à droite.' },
        {
          icon: secure ? 'download' : 'addBox',
          html: secure
            ? 'Choisissez <strong>« Installer l’application »</strong>.'
            : 'Choisissez <strong>« Ajouter à l’écran d’accueil »</strong>, puis <strong>« Créer un raccourci »</strong>.'
        },
        { icon: 'check', html: 'Confirmez : GeniusSend apparaît avec vos autres applications.' }
      ];
    case 'chromium-desktop':
      return secure
        ? [
            { icon: 'download', html: 'Cliquez sur l’icône <strong>Installer</strong> à droite de la barre d’adresse.' },
            { icon: 'menu', html: 'Ou ouvrez le menu <strong>⋮</strong> (ou <strong>…</strong> dans Edge) puis <strong>« Installer GeniusSend »</strong>.' },
            { icon: 'check', html: 'Confirmez : l’application s’ouvre dans sa propre fenêtre.' }
          ]
        : [
            { icon: 'menu', html: 'Dans Chrome, ouvrez le menu <strong>⋮</strong> puis <strong>« Caster, enregistrer et partager »</strong>.' },
            { icon: 'addBox', html: 'Choisissez <strong>« Créer un raccourci… »</strong> et cochez <strong>« Ouvrir dans une fenêtre »</strong>.' },
            { icon: 'check', html: 'Dans Edge : menu <strong>…</strong> → <strong>« Plus d’outils »</strong> → <strong>« Épingler à la barre des tâches »</strong>.' }
          ];
    case 'macos-safari':
      return [
        { icon: 'share', html: 'Dans la barre de menus de Safari, ouvrez <strong>Fichier</strong>.' },
        { icon: 'addBox', html: 'Choisissez <strong>« Ajouter au Dock… »</strong> (macOS Sonoma ou plus récent).' },
        { icon: 'check', html: 'Cliquez sur <strong>« Ajouter »</strong> : GeniusSend apparaît dans le Dock.' }
      ];
    case 'firefox-desktop':
      return [
        { icon: 'desktop', html: 'Firefox ne sait pas installer les applications web sur ordinateur.' },
        { icon: 'download', html: 'Ouvrez cette page dans <strong>Chrome</strong> ou <strong>Edge</strong>, puis cliquez à nouveau sur <strong>Installer l’app</strong>.' }
      ];
    default:
      return [
        { icon: 'menu', html: 'Ouvrez le menu de votre navigateur.' },
        { icon: 'download', html: 'Cherchez <strong>« Installer l’application »</strong> ou <strong>« Ajouter à l’écran d’accueil »</strong>.' }
      ];
  }
}

function createInstallDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'install-dialog';
  dialog.setAttribute('aria-labelledby', 'install-title');
  dialog.innerHTML = `
    <div class="install-hero">
      <img class="install-app-icon" src="/icons/icon-192.png" alt="" width="64" height="64" />
      <div>
        <h2 id="install-title">Installer GeniusSend</h2>
        <p>Sur votre ordinateur, votre téléphone ou votre tablette.</p>
      </div>
      <button class="icon-button dialog-close" type="button" aria-label="Fermer">${icon('close')}</button>
    </div>
    <ul class="install-benefits">
      <li>${icon('bolt')}<span>S’ouvre en un clic, comme une vraie application</span></li>
      <li>${icon('desktop')}<span>Dans sa propre fenêtre, sans barre d’adresse</span></li>
      <li>${icon('download')}<span>Aucun store, rien de lourd à télécharger</span></li>
    </ul>
    <div class="install-notice" hidden>
      ${icon('lock')}
      <p>Cette adresse n’est pas sécurisée (<strong>HTTP</strong>). Les navigateurs réservent l’installation complète aux sites en <strong>HTTPS</strong> : vous pouvez dès maintenant créer un <strong>raccourci</strong> qui s’ouvre comme une application.</p>
    </div>
    <h3 class="install-steps-title">Comment faire</h3>
    <ol class="install-steps"></ol>
    <div class="dialog-actions">
      <button class="primary-button" type="button" data-close>J’ai compris</button>
    </div>
  `;

  dialog.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    // Un clic sur le fond (hors de la boîte) ferme aussi la fenêtre.
    if (target === dialog || target.closest('.dialog-close, [data-close]')) {
      dialog.close();
    }
  });

  document.body.append(dialog);
  return dialog;
}

export function setupInstall(button: HTMLButtonElement, notify: Notify) {
  let deferredPrompt: InstallPromptEvent | null = null;
  let dialog: HTMLDialogElement | null = null;

  const refreshButton = () => {
    button.hidden = isStandalone();
  };

  const openInstructions = () => {
    dialog ??= createInstallDialog();
    const secure = window.isSecureContext;
    const notice = dialog.querySelector('.install-notice') as HTMLElement;
    const steps = dialog.querySelector('.install-steps') as HTMLOListElement;
    notice.hidden = secure;
    steps.innerHTML = installSteps(detectInstallPlatform(), secure)
      .map((step) => `<li><span class="step-icon">${icon(step.icon)}</span><span>${step.html}</span></li>`)
      .join('');
    dialog.showModal();
  };

  refreshButton();
  window.matchMedia('(display-mode: standalone)').addEventListener('change', refreshButton);

  // Chrome et Edge proposent leur propre fenêtre d’installation : on la garde pour notre bouton.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
    button.classList.add('ready');
    refreshButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    button.hidden = true;
    dialog?.close();
    notify('GeniusSend est installé', 'Retrouvez l’application sur votre bureau ou votre écran d’accueil.', 'success');
  });

  button.addEventListener('click', async () => {
    if (deferredPrompt) {
      const prompt = deferredPrompt;
      deferredPrompt = null;
      button.classList.remove('ready');
      try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        if (choice.outcome === 'accepted') {
          button.hidden = true;
        }
        return;
      } catch (error) {
        console.warn('[GeniusSend] fenêtre d’installation indisponible', error);
      }
    }

    openInstructions();
  });
}
