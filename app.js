// Application State
let SQL = null;
let originalDeck = [];
let queue = [];
let totalCardsCount = 0;
let learnedFirstTryCount = 0;
let repeatedCount = 0;

let isFlipped = false;
let mediaFiles = {};

// Touch Drag State
let startX = 0, startY = 0, currentX = 0, currentY = 0;
let isDragging = false;
let isClickPrevented = false;

// DOM Elements
const fileInputHeader = document.getElementById('fileInputHeader');
const fileInputCenter = document.getElementById('fileInputCenter');
const welcomeView = document.getElementById('welcomeView');
const loadingView = document.getElementById('loadingView');
const studyView = document.getElementById('studyView');
const completeView = document.getElementById('completeView');
const loadingStatus = document.getElementById('loadingStatus');

const cardInner = document.getElementById('cardInner');
const cardFront = document.getElementById('cardFront');
const cardBack = document.getElementById('cardBack');
const cardProgress = document.getElementById('cardProgress');
const badgeRight = document.getElementById('badgeRight');
const badgeLeft = document.getElementById('badgeLeft');

const btnAgain = document.getElementById('btnAgain');
const btnGood = document.getElementById('btnGood');
const restartBtn = document.getElementById('restartBtn');
const shuffleBtn = document.getElementById('shuffleBtn');
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');

// Initialize Icons
lucide.createIcons();

// Theme Switcher
themeToggle.addEventListener('click', () => {
  document.documentElement.classList.toggle('dark');
  const isDark = document.documentElement.classList.contains('dark');
  themeIcon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
  lucide.createIcons();
});

// Lazy SQL.js Engine Loader
async function getSQLEngine() {
  if (!SQL) {
    SQL = await initSqlJs({
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
    });
  }
  return SQL;
}

// Lazy Zstandard Decompressor Loader
async function decompressZstd(uint8Array) {
  if (!window.ZstdCodec) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/zstd-codec@0.1.2/bundle/zstd-codec.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  return new Promise((resolve) => {
    window.ZstdCodec.run(zstd => {
      const simple = new zstd.Simple();
      const decompressed = simple.decompress(uint8Array);
      resolve(decompressed);
    });
  });
}

// Upload & Parse .apkg Package
async function handleFileUpload(file) {
  if (!file) return;

  showView('loading');
  updateStatus('Unpacking .apkg package...');

  try {
    const zip = await JSZip.loadAsync(file);
    
    mediaFiles = {};
    const mediaFileEntry = zip.file(/media$/i)[0];
    if (mediaFileEntry) {
      const mediaMapText = await mediaFileEntry.async('text');
      try {
        const mediaMap = JSON.parse(mediaMapText);
        for (const [key, filename] of Object.entries(mediaMap)) {
          const fileData = zip.file(key);
          if (fileData) {
            const blob = await fileData.async('blob');
            mediaFiles[filename] = URL.createObjectURL(blob);
          }
        }
      } catch (err) {
        console.warn('Failed to parse media mapping JSON:', err);
      }
    }

    updateStatus('Opening collection database...');
    let dbBuffer = null;

    const anki21bEntry = zip.file(/collection\.anki21b$/i)[0];
    const anki21Entry = zip.file(/collection\.anki21$/i)[0];
    const anki2Entry = zip.file(/collection\.anki2$/i)[0];

    if (anki21bEntry) {
      updateStatus('Decompressing modern Anki v3 database...');
      const compressedData = await anki21bEntry.async('uint8array');
      dbBuffer = await decompressZstd(compressedData);
    } else if (anki21Entry) {
      dbBuffer = await anki21Entry.async('uint8array');
    } else if (anki2Entry) {
      dbBuffer = await anki2Entry.async('uint8array');
    } else {
      const anyDb = zip.file(/.*\.(anki2|anki21|sqlite|db)$/i)[0];
      if (anyDb) {
        dbBuffer = await anyDb.async('uint8array');
      } else {
        throw new Error('Valid APKG collection database not found in file.');
      }
    }

    const sqlEngine = await getSQLEngine();
    const db = new sqlEngine.Database(dbBuffer);
    
    originalDeck = [];
    const res = db.exec("SELECT flds FROM notes");
    if (res.length > 0 && res[0].values) {
      res[0].values.forEach(row => {
        const fields = row[0].split('\x1f');
        const frontRaw = fields[0] || '';
        const backRaw = fields.length > 1 ? fields.slice(1).join('<br>') : fields[0];

        if (!frontRaw.includes("Please update to the latest Anki version")) {
          originalDeck.push({
            front: processCardText(frontRaw),
            back: processCardText(backRaw),
            hasBeenReviewed: false
          });
        }
      });
    }

    if (originalDeck.length === 0) {
      throw new Error('No valid flashcards found inside this deck.');
    }

    initDeckSession();
    showView('study');

  } catch (err) {
    alert(`Error loading deck: ${err.message}`);
    showView('welcome');
  }
}

fileInputHeader.addEventListener('change', (e) => handleFileUpload(e.target.files[0]));
fileInputCenter.addEventListener('change', (e) => handleFileUpload(e.target.files[0]));

function initDeckSession() {
  queue = originalDeck.map(c => ({ ...c }));
  totalCardsCount = queue.length;
  learnedFirstTryCount = 0;
  repeatedCount = 0;
  showCurrentCard();
}

function processCardText(rawHtml) {
  if (!rawHtml) return '';
  let processed = rawHtml.replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/g, '<span class="cloze">[$1]</span>');

  const parser = new DOMParser();
  const doc = parser.parseFromString(processed, 'text/html');
  const imgs = doc.querySelectorAll('img');

  imgs.forEach(img => {
    const src = img.getAttribute('src');
    if (src && mediaFiles[src]) {
      img.setAttribute('src', mediaFiles[src]);
    }
  });

  return doc.body.innerHTML;
}

function showCurrentCard() {
  if (queue.length === 0) {
    showCompletionScreen();
    return;
  }

  isFlipped = false;
  cardInner.classList.remove('rotate-y-180', 'card-swipe-transition');
  cardInner.style.transform = 'none';
  badgeRight.style.opacity = 0;
  badgeLeft.style.opacity = 0;

  const currentCard = queue[0];
  cardFront.innerHTML = currentCard.front;
  cardBack.innerHTML = currentCard.back;

  cardProgress.innerText = `Remaining: ${queue.length} cards`;
}

function handleAction(direction) {
  if (queue.length === 0) return;
  const card = queue.shift();

  if (direction === 'right') {
    if (!card.hasBeenReviewed) learnedFirstTryCount++;
  } else {
    card.hasBeenReviewed = true;
    repeatedCount++;
    queue.push(card);
  }

  showCurrentCard();
}

// Touch Drag Handlers
function onTouchStart(e) {
  if (queue.length === 0) return;
  isDragging = true;
  isClickPrevented = false;
  const touch = e.touches ? e.touches[0] : e;
  startX = touch.clientX;
  startY = touch.clientY;
  cardInner.classList.remove('card-swipe-transition');
}

function onTouchMove(e) {
  if (!isDragging) return;
  const touch = e.touches ? e.touches[0] : e;
  currentX = touch.clientX - startX;
  currentY = touch.clientY - startY;

  if (Math.abs(currentX) > 10) isClickPrevented = true;

  const rotateDeg = currentX * 0.08;
  const flipRotation = isFlipped ? 'rotateY(180deg)' : '';
  cardInner.style.transform = `translate3d(${currentX}px, ${currentY}px, 0) rotate(${rotateDeg}deg) ${flipRotation}`;

  const opacity = Math.min(Math.abs(currentX) / 100, 1);
  if (currentX > 0) {
    badgeRight.style.opacity = opacity;
    badgeLeft.style.opacity = 0;
  } else {
    badgeLeft.style.opacity = opacity;
    badgeRight.style.opacity = 0;
  }
}

function onTouchEnd() {
  if (!isDragging) return;
  isDragging = false;
  cardInner.classList.add('card-swipe-transition');

  const threshold = 110;
  if (currentX > threshold) {
    cardInner.style.transform = `translate3d(1000px, ${currentY}px, 0) rotate(45deg)`;
    setTimeout(() => handleAction('right'), 200);
  } else if (currentX < -threshold) {
    cardInner.style.transform = `translate3d(-1000px, ${currentY}px, 0) rotate(-45deg)`;
    setTimeout(() => handleAction('left'), 200);
  } else {
    const flipRotation = isFlipped ? 'rotateY(180deg)' : '';
    cardInner.style.transform = flipRotation ? flipRotation : 'none';
    badgeRight.style.opacity = 0;
    badgeLeft.style.opacity = 0;
  }

  currentX = 0;
  currentY = 0;
}

// Touch and Click Event Listeners
cardInner.addEventListener('touchstart', onTouchStart, { passive: true });
cardInner.addEventListener('touchmove', onTouchMove, { passive: true });
cardInner.addEventListener('touchend', onTouchEnd);

cardInner.addEventListener('mousedown', onTouchStart);
window.addEventListener('mousemove', onTouchMove);
window.addEventListener('mouseup', onTouchEnd);

cardInner.addEventListener('click', () => {
  if (isClickPrevented) return;
  isFlipped = !isFlipped;
  cardInner.classList.toggle('rotate-y-180');
});

btnAgain.addEventListener('click', () => {
  cardInner.classList.add('card-swipe-transition');
  cardInner.style.transform = 'translate3d(-1000px, 0, 0) rotate(-30deg)';
  setTimeout(() => handleAction('left'), 200);
});

btnGood.addEventListener('click', () => {
  cardInner.classList.add('card-swipe-transition');
  cardInner.style.transform = 'translate3d(1000px, 0, 0) rotate(30deg)';
  setTimeout(() => handleAction('right'), 200);
});

shuffleBtn.addEventListener('click', () => {
  queue.sort(() => Math.random() - 0.5);
  showCurrentCard();
});

restartBtn.addEventListener('click', () => {
  initDeckSession();
  showView('study');
});

function showCompletionScreen() {
  document.getElementById('statTotal').innerText = totalCardsCount;
  document.getElementById('statLearned').innerText = learnedFirstTryCount;
  document.getElementById('statRepeated').innerText = repeatedCount;
  showView('complete');
}

function showView(viewName) {
  welcomeView.classList.add('hidden');
  loadingView.classList.add('hidden');
  studyView.classList.add('hidden');
  completeView.classList.add('hidden');

  if (viewName === 'welcome') welcomeView.classList.remove('hidden');
  if (viewName === 'loading') loadingView.classList.remove('hidden');
  if (viewName === 'study') studyView.classList.remove('hidden');
  if (viewName === 'complete') completeView.classList.remove('hidden');
}

function updateStatus(text) {
  loadingStatus.innerText = text;
}