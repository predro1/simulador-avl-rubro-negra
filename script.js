// ============================================================================
// CONFIGURAÇÕES DE CORES E ESTADO GLOBAL
// ============================================================================
const COLORS = {
  AVL_NODE: '#003b75',       // Cor solicitada para nós da AVL
  AVL_STROKE: '#002244',
  RB_RED: '#C52613',         // Cor solicitada para nós Rubros
  RB_BLACK: '#000000',       // Cor solicitada para nós Negros
  EDGE: '#2c3e50',
  AURA_OK: '#10b981',        // Aura verde (equilibrado)
  AURA_BAD: '#ef4444'        // Aura vermelha (desequilibrado)
};

let currentMode = 'AVL';     // 'AVL' ou 'RB'
let pendingQueue = [];       // Fila começa vazia; pré-fila entra apenas se clicada
let frames = [];             // Lista linear de estados/passos
let currentFrameIdx = -1;

// Pilha de Undo para suportar Ctrl+Z em qualquer ação (passos, exclusões, limpezas)
let undoStack = [];

let isAnimating = false;
let autoPlayTimer = null;
let selectedNodeKey = null;

// Estado da árvore lógica acumulada no fim da lista de frames
let avlRoot = null;
let rbRoot = null;
let totalRotations = 0;
let totalRecolors = 0;

// Câmera (Zoom e Pan)
let cam = { x: 0, y: 55, scale: 1 };
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let previousPositions = new Map();

// ============================================================================
// FUNÇÕES UTILITÁRIAS E DE CLONAGEM PROFUNDA (SEM BUG DE REFERÊNCIA)
// ============================================================================
function cloneTree(node) {
  if (!node) return null;
  return {
    key: node.key,
    h: node.h || 1,
    color: node.color || 'BLACK',
    left: cloneTree(node.left),
    right: cloneTree(node.right)
  };
}

function getHeight(node) {
  if (!node) return 0;
  return 1 + Math.max(getHeight(node.left), getHeight(node.right));
}

function getFB(node) {
  if (!node) return 0;
  return getHeight(node.right) - getHeight(node.left);
}

function countNodes(node) {
  if (!node) return 0;
  return 1 + countNodes(node.left) + countNodes(node.right);
}

function getBlackHeight(node) {
  if (!node) return 1;
  return getBlackHeight(node.left) + (node.color === 'BLACK' ? 1 : 0);
}

function findKey(node, key) {
  if (!node) return false;
  if (node.key === key) return true;
  return key < node.key ? findKey(node.left, key) : findKey(node.right, key);
}

function findNodeObj(node, key) {
  if (!node) return null;
  if (node.key === key) return node;
  return key < node.key ? findNodeObj(node.left, key) : findNodeObj(node.right, key);
}

// Verifica se a árvore AVL possui algum nó com |FB| > 1
function hasAVLImbalance(node) {
  if (!node) return false;
  if (Math.abs(getFB(node)) > 1) return true;
  return hasAVLImbalance(node.left) || hasAVLImbalance(node.right);
}

// Verifica se a árvore Rubro-Negra viola Regra 2 (raiz rubra) ou Regra 4 (dois rubros seguidos)
function hasRBViolation(root) {
  if (!root) return false;
  if (root.color === 'RED') return true;
  function checkRec(n) {
    if (!n) return false;
    if (n.color === 'RED') {
      if ((n.left && n.left.color === 'RED') || (n.right && n.right.color === 'RED')) {
        return true;
      }
    }
    return checkRec(n.left) || checkRec(n.right);
  }
  return checkRec(root);
}

// ============================================================================
// SISTEMA DE DESFAZER (UNDO / CTRL + Z)
// ============================================================================
function saveSnapshotForUndo() {
  undoStack.push({
    currentMode,
    pendingQueue: [...pendingQueue],
    frames: frames.map(f => ({
      ...f,
      tree: cloneTree(f.tree)
    })),
    currentFrameIdx,
    avlRoot: cloneTree(avlRoot),
    rbRoot: cloneTree(rbRoot),
    totalRotations,
    totalRecolors
  });
  if (undoStack.length > 60) undoStack.shift();
  updateUndoButtonUI();
}

function undoStep() {
  stopAutoPlay();
  closeNodePopup();
  if (undoStack.length === 0) return;

  const snap = undoStack.pop();
  currentMode = snap.currentMode;
  pendingQueue = snap.pendingQueue;
  frames = snap.frames;
  currentFrameIdx = snap.currentFrameIdx;
  avlRoot = snap.avlRoot;
  rbRoot = snap.rbRoot;
  totalRotations = snap.totalRotations;
  totalRecolors = snap.totalRecolors;

  document.getElementById('btnModeAVL').classList.toggle('active', currentMode === 'AVL');
  document.getElementById('btnModeRB').classList.toggle('active', currentMode === 'RB');
  document.getElementById('lblShowNil').classList.toggle('hidden', currentMode !== 'RB');

  updateRulesBox();
  renderQueueBar();
  renderCurrentFrame(true);
  rebuildLogList();
  updateUndoButtonUI();
}

function updateUndoButtonUI() {
  const btn = document.getElementById('btnUndo');
  if (btn) btn.disabled = (undoStack.length === 0);
}

// ============================================================================
// MOTOR 1: ÁRVORE AVL (INSERÇÃO E REMOÇÃO SEM BUG DE RAIZ)
// ============================================================================
function updateAVLHeights(node) {
  if (!node) return 0;
  node.h = 1 + Math.max(updateAVLHeights(node.left), updateAVLHeights(node.right));
  return node.h;
}

function rotRightAVL(y) {
  const x = y.left;
  const T2 = x.right;
  x.right = y;
  y.left = T2;
  updateAVLHeights(y);
  updateAVLHeights(x);
  return x;
}

function rotLeftAVL(x) {
  const y = x.right;
  const T2 = y.left;
  y.left = x;
  x.right = T2;
  updateAVLHeights(x);
  updateAVLHeights(y);
  return y;
}

// Substitui um nó ou a própria raiz corretamente (corrige o bug do 3º passo!)
function replaceSubtreeOrRoot(root, targetKey, newSubtree) {
  if (!root) return newSubtree;
  if (root.key === targetKey) return newSubtree;

  function rec(n) {
    if (!n) return;
    if (n.left && n.left.key === targetKey) {
      n.left = newSubtree;
      return;
    }
    if (n.right && n.right.key === targetKey) {
      n.right = newSubtree;
      return;
    }
    rec(n.left);
    rec(n.right);
  }
  rec(root);
  return root;
}

function generateAVLStepsForKey(key) {
  if (findKey(avlRoot, key)) return;
  const newFrames = [];

  function bstInsert(node) {
    if (!node) return { key, h: 1, left: null, right: null };
    if (key < node.key) node.left = bstInsert(node.left);
    else if (key > node.key) node.right = bstInsert(node.right);
    return node;
  }

  avlRoot = bstInsert(avlRoot);
  updateAVLHeights(avlRoot);

  const willUnbalance = hasAVLImbalance(avlRoot);

  // Passo 1: Nó recém-adicionado (aura verde se equilibrado, aura vermelha se desbalancear)
  newFrames.push({
    tree: cloneTree(avlRoot),
    type: willUnbalance ? 'INSERT_BAD' : 'INSERT_OK',
    focusKey: key,
    auraColor: willUnbalance ? 'RED' : 'GREEN',
    rotationsCount: totalRotations,
    badge: willUnbalance ? `DESEQUILÍBRIO DETECTADO (${key})` : `INSERÇÃO EQUILIBRADA (${key})`,
    banner: willUnbalance
      ? `Nó ${key} inserido: a árvore desequilibrou (aura vermelha)! Rebalanceamento necessário.`
      : `Nó ${key} inserido com sucesso: a árvore permanece equilibrada (aura verde).`,
    explanation: willUnbalance
      ? `O valor <strong>${key}</strong> foi inserido como folha, mas fez com que um ancestral atingisse <strong>|FB| = 2</strong>. Por isso sua aura ficou <strong style="color:#ef4444;">vermelha</strong>. Clique em <em>Passo Manual</em> para executar a rotação.`
      : `O valor <strong>${key}</strong> foi inserido como folha e todos os nós mantiveram <strong>FB ∈ {-1, 0, +1}</strong>. Sua aura permanece <strong style="color:#10b981;">verde</strong>.`
  });

  // Sobe do nó inserido até a raiz procurando o primeiro ancestral com |FB| > 1
  function rebalanceBottomUp(node) {
    if (!node) return node;
    if (key < node.key) node.left = rebalanceBottomUp(node.left);
    else if (key > node.key) node.right = rebalanceBottomUp(node.right);

    updateAVLHeights(node);
    const fb = getFB(node);

    // Caso LL
    if (fb < -1 && getFB(node.left) <= 0) {
      const pivotKey = node.key;
      const childKey = node.left.key;

      newFrames.push({
        tree: cloneTree(avlRoot),
        type: 'ALERT',
        focusKey: pivotKey,
        auraColor: 'RED',
        dir: 'CW',
        rotationsCount: totalRotations,
        badge: `CASO LL (ROTAÇÃO DIREITA)`,
        banner: `Nó ${pivotKey} com FB = ${fb}. Preparando Rotação Simples à Direita (↻).`,
        explanation: `O nó <strong>${pivotKey}</strong> pende para a esquerda (FB = ${fb}) em linha reta com <strong>${childKey}</strong>. Aplicaremos uma <strong>Rotação Simples à Direita</strong>.`
      });

      const rotated = rotRightAVL(node);
      avlRoot = replaceSubtreeOrRoot(avlRoot, pivotKey, rotated);
      updateAVLHeights(avlRoot);
      totalRotations++;

      newFrames.push({
        tree: cloneTree(avlRoot),
        type: 'ROTATE_DONE',
        focusKey: rotated.key,
        auraColor: 'GREEN',
        rotationsCount: totalRotations,
        badge: `EQUILÍBRIO RESTAURADO (LL)`,
        banner: `Rotação concluída: ${rotated.key} subiu e ${pivotKey} desceu à direita.`,
        explanation: `<strong>Caso LL concluído:</strong> O nó <strong>${rotated.key}</strong> assumiu a raiz desta subárvore e todos os fatores de balanceamento voltaram ao intervalo permitido.`
      });
      return rotated;
    }

    // Caso RR
    if (fb > 1 && getFB(node.right) >= 0) {
      const pivotKey = node.key;
      const childKey = node.right.key;

      newFrames.push({
        tree: cloneTree(avlRoot),
        type: 'ALERT',
        focusKey: pivotKey,
        auraColor: 'RED',
        dir: 'CCW',
        rotationsCount: totalRotations,
        badge: `CASO RR (ROTAÇÃO ESQUERDA)`,
        banner: `Nó ${pivotKey} com FB = +${fb}. Preparando Rotação Simples à Esquerda (↺).`,
        explanation: `O nó <strong>${pivotKey}</strong> ficou pesado à direita (FB = +${fb}) em linha reta com <strong>${childKey}</strong>. Aplicaremos uma <strong>Rotação Simples à Esquerda</strong>.`
      });

      const rotated = rotLeftAVL(node);
      avlRoot = replaceSubtreeOrRoot(avlRoot, pivotKey, rotated);
      updateAVLHeights(avlRoot);
      totalRotations++;

      newFrames.push({
        tree: cloneTree(avlRoot),
        type: 'ROTATE_DONE',
        focusKey: rotated.key,
        auraColor: 'GREEN',
        rotationsCount: totalRotations,
        badge: `EQUILÍBRIO RESTAURADO (RR)`,
        banner: `Rotação concluída: ${rotated.key} subiu e ${pivotKey} desceu à esquerda.`,
        explanation: `<strong>Caso RR concluído:</strong> O nó <strong>${rotated.key}</strong> subiu para equilibrar a estrutura e <strong>${pivotKey}</strong> tornou-se seu filho esquerdo.`
      });
      return rotated;
    }

    // Caso LR
    if (fb < -1 && getFB(node.left) > 0) {
      const pivotKey = node.key;
      const childKey = node.left.key;

      newFrames.push({
        tree: cloneTree(avlRoot),
        type: 'ALERT',
        focusKey: childKey,
        auraColor: 'RED',
        dir: 'CCW',
        rotationsCount: totalRotations,
        badge: `CASO LR (PASSO 1/2)`,
        banner: `Cotovelo Esquerda-Direita em ${pivotKey}. Passo 1: Girar filho ${childKey} à esquerda.`,
        explanation: `O nó <strong>${pivotKey}</strong> tem FB = -2 e seu filho <strong>${childKey}</strong> tem FB = +1. Primeiro giramos <strong>${childKey}</strong> à esquerda para alinhar os nós.`
      });

      node.left = rotLeftAVL(node.left);
      updateAVLHeights(avlRoot);
      totalRotations++;

      newFrames.push({
        tree: cloneTree(avlRoot),
        type: 'ALERT',
        focusKey: pivotKey,
        auraColor: 'RED',
        dir: 'CW',
        rotationsCount: totalRotations,
        badge: `CASO LR (PASSO 2/2)`,
        banner: `Ramo alinhado! Passo 2: Rotação à Direita no ancestral ${pivotKey}.`,
        explanation: `Agora que o ramo esquerdo está alinhado (Caso LL), rotacionamos <strong>${pivotKey}</strong> à direita.`
      });

      const rotated = rotRightAVL(node);
      avlRoot = replaceSubtreeOrRoot(avlRoot, pivotKey, rotated);
      updateAVLHeights(avlRoot);
      totalRotations++;

      newFrames.push({
        tree: cloneTree(avlRoot),
        type: 'ROTATE_DONE',
        focusKey: rotated.key,
        auraColor: 'GREEN',
        rotationsCount: totalRotations,
        badge: `EQUILÍBRIO RESTAURADO (LR)`,
        banner: `Rotação Dupla LR finalizada com ${rotated.key} no topo local.`,
        explanation: `<strong>Caso LR concluído:</strong> O nó <strong>${rotated.key}</strong> subiu, deixando <strong>${childKey}</strong> à esquerda e <strong>${pivotKey}</strong> à direita.`
      });
      return rotated;
    }

    // Caso RL
    if (fb > 1 && getFB(node.right) < 0) {
      const pivotKey = node.key;
      const childKey = node.right.key;

      newFrames.push({
        tree: cloneTree(avlRoot),
        type: 'ALERT',
        focusKey: childKey,
        auraColor: 'RED',
        dir: 'CW',
        rotationsCount: totalRotations,
        badge: `CASO RL (PASSO 1/2)`,
        banner: `Cotovelo Direita-Esquerda em ${pivotKey}. Passo 1: Girar filho ${childKey} à direita.`,
        explanation: `O nó <strong>${pivotKey}</strong> tem FB = +2 e seu filho <strong>${childKey}</strong> tem FB = -1. Primeiro giramos <strong>${childKey}</strong> à direita.`
      });

      node.right = rotRightAVL(node.right);
      updateAVLHeights(avlRoot);
      totalRotations++;

      newFrames.push({
        tree: cloneTree(avlRoot),
        type: 'ALERT',
        focusKey: pivotKey,
        auraColor: 'RED',
        dir: 'CCW',
        rotationsCount: totalRotations,
        badge: `CASO RL (PASSO 2/2)`,
        banner: `Ramo alinhado! Passo 2: Rotação à Esquerda no ancestral ${pivotKey}.`,
        explanation: `Com os nós alinhados à direita, aplicamos a rotação à esquerda em <strong>${pivotKey}</strong>.`
      });

      const rotated = rotLeftAVL(node);
      avlRoot = replaceSubtreeOrRoot(avlRoot, pivotKey, rotated);
      updateAVLHeights(avlRoot);
      totalRotations++;

      newFrames.push({
        tree: cloneTree(avlRoot),
        type: 'ROTATE_DONE',
        focusKey: rotated.key,
        auraColor: 'GREEN',
        rotationsCount: totalRotations,
        badge: `EQUILÍBRIO RESTAURADO (RL)`,
        banner: `Rotação Dupla RL finalizada com ${rotated.key} no topo local.`,
        explanation: `<strong>Caso RL concluído:</strong> O nó <strong>${rotated.key}</strong> subiu, equilibrando <strong>${pivotKey}</strong> e <strong>${childKey}</strong>.`
      });
      return rotated;
    }

    return node;
  }

  avlRoot = rebalanceBottomUp(avlRoot);
  updateAVLHeights(avlRoot);
  frames.push(...newFrames);
}

// Remoção em Árvore AVL com Rebalanceamento
function deleteNodeFromAVL(targetKey) {
  function minValueNode(n) {
    let curr = n;
    while (curr.left) curr = curr.left;
    return curr;
  }

  function deleteRec(root, key) {
    if (!root) return root;
    if (key < root.key) root.left = deleteRec(root.left, key);
    else if (key > root.key) root.right = deleteRec(root.right, key);
    else {
      if (!root.left || !root.right) {
        root = root.left ? root.left : root.right;
      } else {
        const temp = minValueNode(root.right);
        root.key = temp.key;
        root.right = deleteRec(root.right, temp.key);
      }
    }
    if (!root) return root;

    updateAVLHeights(root);
    const fb = getFB(root);

    if (fb < -1 && getFB(root.left) <= 0) {
      totalRotations++;
      return rotRightAVL(root);
    }
    if (fb < -1 && getFB(root.left) > 0) {
      root.left = rotLeftAVL(root.left);
      totalRotations += 2;
      return rotRightAVL(root);
    }
    if (fb > 1 && getFB(root.right) >= 0) {
      totalRotations++;
      return rotLeftAVL(root);
    }
    if (fb > 1 && getFB(root.right) < 0) {
      root.right = rotRightAVL(root.right);
      totalRotations += 2;
      return rotLeftAVL(root);
    }
    return root;
  }

  avlRoot = deleteRec(avlRoot, targetKey);
  updateAVLHeights(avlRoot);

  frames.push({
    tree: cloneTree(avlRoot),
    type: 'ROTATE_DONE',
    focusKey: avlRoot ? avlRoot.key : null,
    auraColor: 'GREEN',
    rotationsCount: totalRotations,
    badge: `REMOÇÃO (${targetKey})`,
    banner: `Nó ${targetKey} excluído e árvore AVL rebalanceada automaticamente.`,
    explanation: `O nó <strong>${targetKey}</strong> foi removido seguindo as regras de sucessor em-ordem e todos os ancestrais tiveram seus Fatores de Balanceamento corrigidos.`
  });
}

// ============================================================================
// MOTOR 2: ÁRVORE RUBRO-NEGRA (INSERÇÃO E REMOÇÃO)
// ============================================================================
function attachParents(node, parent = null) {
  if (!node) return;
  node.p = parent;
  attachParents(node.left, node);
  attachParents(node.right, node);
}

function rbRotateLeft(root, xKey) {
  attachParents(root);
  const x = findNodeObj(root, xKey);
  const y = x.right;
  x.right = y.left;
  if (y.left) y.left.p = x;
  y.p = x.p;
  if (!x.p) root = y;
  else if (x === x.p.left) x.p.left = y;
  else x.p.right = y;
  y.left = x;
  x.p = y;
  return root;
}

function rbRotateRight(root, yKey) {
  attachParents(root);
  const y = findNodeObj(root, yKey);
  const x = y.left;
  y.left = x.right;
  if (x.right) x.right.p = y;
  x.p = y.p;
  if (!y.p) root = x;
  else if (y === y.p.right) y.p.right = x;
  else y.p.left = x;
  x.right = y;
  y.p = x;
  return root;
}

function generateRBStepsForKey(key) {
  if (findKey(rbRoot, key)) return;
  const newFrames = [];

  function bstInsert(node) {
    if (!node) return { key, color: 'RED', left: null, right: null };
    if (key < node.key) node.left = bstInsert(node.left);
    else if (key > node.key) node.right = bstInsert(node.right);
    return node;
  }

  rbRoot = bstInsert(rbRoot);
  const hasViolation = hasRBViolation(rbRoot);

  newFrames.push({
    tree: cloneTree(rbRoot),
    type: hasViolation ? 'INSERT_BAD' : 'INSERT_OK',
    focusKey: key,
    auraColor: hasViolation ? 'RED' : 'GREEN',
    rotationsCount: totalRotations,
    badge: hasViolation ? `VIOLAÇÃO RUBRO-NEGRA (${key})` : `INSERÇÃO VÁLIDA (${key})`,
    banner: hasViolation
      ? `Nó ${key} nasceu RUBRO e gerou conflito de cor (aura vermelha)!`
      : `Nó ${key} nasceu RUBRO com pai NEGRO: todas as 5 regras estão válidas (aura verde).`,
    explanation: hasViolation
      ? `O nó <strong>${key}</strong> foi inserido como <strong>RUBRO</strong>, mas violou a Regra 2 (se for a raiz) ou a Regra 4 (pai também é RUBRO). Sua aura ficou <strong style="color:#ef4444;">vermelha</strong>.`
      : `O nó <strong>${key}</strong> nasceu <strong>RUBRO</strong> abaixo de um pai NEGRO. Nenhuma propriedade foi violada e a aura permanece <strong style="color:#10b981;">verde</strong>.`
  });

  let zKey = key;
  while (true) {
    attachParents(rbRoot);
    let z = findNodeObj(rbRoot, zKey);
    if (!z || !z.p || z.p.color !== 'RED') break;

    let p = z.p;
    let g = p.p;
    if (!g) break;

    const isLeftBranch = (p === g.left);
    const uncle = isLeftBranch ? g.right : g.left;
    const uncleIsRed = (uncle && uncle.color === 'RED');

    if (uncleIsRed) {
      p.color = 'BLACK';
      uncle.color = 'BLACK';
      g.color = 'RED';
      totalRecolors++;

      const stillViolates = hasRBViolation(rbRoot);
      newFrames.push({
        tree: cloneTree(rbRoot),
        type: stillViolates ? 'ALERT' : 'ROTATE_DONE',
        focusKey: g.key,
        auraColor: stillViolates ? 'RED' : 'GREEN',
        rotationsCount: totalRotations,
        badge: `CASO 1 (RECOLORAÇÃO)`,
        banner: `Pai (${p.key}) e Tio (${uncle.key}) viram NEGROS; Avô (${g.key}) vira RUBRO.`,
        explanation: `<strong>Caso 1 (Tio Rubro):</strong> Recolorimos pai e tio para NEGRO e avô para RUBRO sem girar nós. A verificação sobe para o avô <strong>${g.key}</strong>.`
      });

      zKey = g.key;
    } else {
      if (isLeftBranch && z === p.right) {
        const pKey = p.key;
        newFrames.push({
          tree: cloneTree(rbRoot),
          type: 'ALERT',
          focusKey: pKey,
          auraColor: 'RED',
          dir: 'CCW',
          rotationsCount: totalRotations,
          badge: `CASO 2 (ZIGUE-ZAGUE)`,
          banner: `Tio é NEGRO em cotovelo: Rotação à Esquerda no pai (${pKey}).`,
          explanation: `<strong>Caso 2:</strong> Giramos o pai <strong>${pKey}</strong> à esquerda para alinhar os dois nós rubros e converter no Caso 3.`
        });
        rbRoot = rbRotateLeft(rbRoot, pKey);
        totalRotations++;
        zKey = pKey;
        attachParents(rbRoot);
        z = findNodeObj(rbRoot, zKey);
        p = z.p;
        g = p.p;
      } else if (!isLeftBranch && z === p.left) {
        const pKey = p.key;
        newFrames.push({
          tree: cloneTree(rbRoot),
          type: 'ALERT',
          focusKey: pKey,
          auraColor: 'RED',
          dir: 'CW',
          rotationsCount: totalRotations,
          badge: `CASO 2 (ZIGUE-ZAGUE)`,
          banner: `Tio é NEGRO em cotovelo: Rotação à Direita no pai (${pKey}).`,
          explanation: `<strong>Caso 2:</strong> Giramos o pai <strong>${pKey}</strong> à direita para alinhar os nós rubros e preparar o Caso 3.`
        });
        rbRoot = rbRotateRight(rbRoot, pKey);
        totalRotations++;
        zKey = pKey;
        attachParents(rbRoot);
        z = findNodeObj(rbRoot, zKey);
        p = z.p;
        g = p.p;
      }

      const pKey = p.key;
      const gKey = g.key;
      const rotDir = isLeftBranch ? 'CW' : 'CCW';

      newFrames.push({
        tree: cloneTree(rbRoot),
        type: 'ALERT',
        focusKey: gKey,
        auraColor: 'RED',
        dir: rotDir,
        rotationsCount: totalRotations,
        badge: `CASO 3 (LINHA RETA)`,
        banner: `Tio NEGRO alinhado: Recolorir pai (${pKey}) e avô (${gKey}) + Rotacionar avô.`,
        explanation: `<strong>Caso 3:</strong> O pai <strong>${pKey}</strong> fica NEGRO, o avô <strong>${gKey}</strong> fica RUBRO e rotacionamos o avô.`
      });

      p.color = 'BLACK';
      g.color = 'RED';
      totalRecolors++;
      rbRoot = isLeftBranch ? rbRotateRight(rbRoot, gKey) : rbRotateLeft(rbRoot, gKey);
      totalRotations++;

      newFrames.push({
        tree: cloneTree(rbRoot),
        type: 'ROTATE_DONE',
        focusKey: pKey,
        auraColor: 'GREEN',
        rotationsCount: totalRotations,
        badge: `EQUILÍBRIO RESTAURADO (CASO 3)`,
        banner: `Subárvore reequilibrada com ${pKey} (NEGRO) no topo local.`,
        explanation: `A violação de dois nós rubros consecutivos foi eliminada com sucesso.`
      });
      break;
    }
  }

  if (rbRoot && rbRoot.color === 'RED') {
    rbRoot.color = 'BLACK';
    totalRecolors++;
    newFrames.push({
      tree: cloneTree(rbRoot),
      type: 'ROTATE_DONE',
      focusKey: rbRoot.key,
      auraColor: 'GREEN',
      rotationsCount: totalRotations,
      badge: `REGRA 2 (RAIZ NEGRA)`,
      banner: `A raiz (${rbRoot.key}) foi pintada de NEGRO (#000000).`,
      explanation: `<strong>Regra 2 cumprida:</strong> A raiz da árvore foi repintada de NEGRO, mantendo a árvore 100% equilibrada.`
    });
  }

  frames.push(...newFrames);
}

// Exclusão em Árvore Rubro-Negra reconstruindo propriedades de forma limpa
function deleteNodeFromRB(targetKey) {
  const remainingKeys = [];
  function collectInOrder(n) {
    if (!n) return;
    collectInOrder(n.left);
    if (n.key !== targetKey) remainingKeys.push(n.key);
    collectInOrder(n.right);
  }
  collectInOrder(rbRoot);

  rbRoot = null;
  const savedFrames = [...frames];
  frames = [];
  remainingKeys.forEach(k => generateRBStepsForKey(k));
  frames = savedFrames;

  frames.push({
    tree: cloneTree(rbRoot),
    type: 'ROTATE_DONE',
    focusKey: rbRoot ? rbRoot.key : null,
    auraColor: 'GREEN',
    rotationsCount: totalRotations,
    badge: `REMOÇÃO (${targetKey})`,
    banner: `Nó ${targetKey} excluído e propriedades Rubro-Negras restauradas.`,
    explanation: `O nó <strong>${targetKey}</strong> foi removido da estrutura preservando as 5 propriedades de coloração e altura-negra.`
  });
}

// ============================================================================
// CONTROLES DE PASSO MANUAL E PASSO AUTOMÁTICO
// ============================================================================
function stepManual() {
  if (isAnimating) return;
  closeNodePopup();

  // Se ainda há sub-etapas pendentes da inserção atual, avança 1 micro-etapa
  if (currentFrameIdx < frames.length - 1) {
    saveSnapshotForUndo();
    currentFrameIdx++;
    renderCurrentFrame(true);
    rebuildLogList();
    return;
  }

  // Caso contrário, puxa o próximo número da fila e mostra sua entrada inicial (aura verde ou vermelha)
  if (pendingQueue.length > 0) {
    saveSnapshotForUndo();
    const nextVal = pendingQueue.shift();
    const prevLen = frames.length;

    if (currentMode === 'AVL') generateAVLStepsForKey(nextVal);
    else generateRBStepsForKey(nextVal);

    if (frames.length > prevLen) {
      currentFrameIdx = prevLen; // Posiciona exatamente no frame de entrada (com a aura)
      renderQueueBar();
      renderCurrentFrame(true);
      rebuildLogList();
    }
  } else {
    stopAutoPlay();
  }
}

function stepAuto() {
  if (isAnimating) return;
  closeNodePopup();

  // Se estava no meio de um passo manual, conclui todas as rotações pendentes desse nó
  if (currentFrameIdx < frames.length - 1) {
    saveSnapshotForUndo();
    currentFrameIdx = frames.length - 1;
    renderCurrentFrame(true);
    rebuildLogList();
    return;
  }

  // Se não há passos pendentes, puxa o próximo da fila e já salta direto para o estado final corrigido
  if (pendingQueue.length > 0) {
    saveSnapshotForUndo();
    const nextVal = pendingQueue.shift();
    if (currentMode === 'AVL') generateAVLStepsForKey(nextVal);
    else generateRBStepsForKey(nextVal);

    currentFrameIdx = frames.length - 1;
    renderQueueBar();
    renderCurrentFrame(true);
    rebuildLogList();
  }
}

// Inserir Direto entra pelo Passo Manual
function insertDirectManualFromInput() {
  const nums = parseInputNumbers();
  if (!nums.length) return;
  saveSnapshotForUndo();

  // Se ainda havia micro-passos anteriores em aberto, finaliza-os primeiro
  currentFrameIdx = frames.length - 1;

  const firstVal = nums.shift();
  // Se o usuário digitou mais de um número, os demais vão para o início da fila
  if (nums.length > 0) {
    pendingQueue.unshift(...nums);
  }

  const prevLen = frames.length;
  if (currentMode === 'AVL') generateAVLStepsForKey(firstVal);
  else generateRBStepsForKey(firstVal);

  if (frames.length > prevLen) {
    currentFrameIdx = prevLen; // Entra pelo Passo Manual (mostrando a aura verde ou vermelha)
  }
  renderQueueBar();
  renderCurrentFrame(true);
  rebuildLogList();
}

// ============================================================================
// GERENCIAMENTO DE FILA, PRÉ-FILA E LIMPEZA SEPARADA
// ============================================================================
function parseInputNumbers() {
  const raw = document.getElementById('inputValues').value.trim();
  if (!raw) return [];
  const nums = raw
    .split(/[\s,;]+/)
    .map(v => parseInt(v, 10))
    .filter(v => !isNaN(v));
  document.getElementById('inputValues').value = '';
  return nums;
}

function enqueueFromInput() {
  const nums = parseInputNumbers();
  if (!nums.length) return;
  saveSnapshotForUndo();
  const activeTree = currentFrameIdx >= 0 ? frames[currentFrameIdx].tree : null;

  nums.forEach(n => {
    if (!pendingQueue.includes(n) && !findKey(activeTree, n)) {
      pendingQueue.push(n);
    }
  });
  renderQueueBar();
}

// Pré-fila de 10, 20, 30, 40, 50 acionada apenas quando clicada
function loadPresetQueue() {
  saveSnapshotForUndo();
  const preset = [10, 20, 30, 40, 50];
  const activeTree = currentFrameIdx >= 0 ? frames[currentFrameIdx].tree : null;

  preset.forEach(n => {
    if (!pendingQueue.includes(n) && !findKey(activeTree, n)) {
      pendingQueue.push(n);
    }
  });
  renderQueueBar();
}

// Limpar a árvore NÃO limpa a fila
function clearTreeOnly() {
  stopAutoPlay();
  closeNodePopup();
  if (!avlRoot && !rbRoot && frames.length === 0) return;

  saveSnapshotForUndo();
  avlRoot = null;
  rbRoot = null;
  frames = [];
  currentFrameIdx = -1;
  totalRotations = 0;
  totalRecolors = 0;
  previousPositions.clear();

  document.getElementById('actionBanner').classList.add('hidden');
  document.getElementById('stepExplanation').innerHTML =
    'Árvore limpa (a fila de inserção foi mantida). Use <strong>Passo Manual</strong> ou <strong>Passo Automático</strong> para continuar.';
  renderCurrentFrame(false);
  rebuildLogList();
}

// Botão dedicado para limpar apenas a fila
function clearQueueOnly() {
  if (pendingQueue.length === 0) return;
  saveSnapshotForUndo();
  pendingQueue = [];
  renderQueueBar();
}

function renderQueueBar() {
  const container = document.getElementById('queueItems');
  if (pendingQueue.length === 0) {
    container.innerHTML = '<span style="font-size:0.78rem;color:#64748b;">Fila vazia (clique em "Pré-fila: 10, 20, 30, 40, 50" ou adicione valores)</span>';
    return;
  }
  container.innerHTML = pendingQueue
    .map((k, idx) => `<span class="q-chip ${idx === 0 ? 'next' : ''}">${k}</span>`)
    .join('');
}

// ============================================================================
// SELEÇÃO E EXCLUSÃO DE NÓ AO CLICAR
// ============================================================================
function onNodeClick(event, key, screenX, screenY) {
  event.stopPropagation();
  const frame = frames[currentFrameIdx];
  if (!frame || !frame.tree) return;

  // Se houver micro-passos pendentes, sincroniza antes de abrir opção de exclusão
  selectedNodeKey = key;
  const nodeObj = findNodeObj(frame.tree, key);
  if (!nodeObj) return;

  const popup = document.getElementById('nodePopup');
  const title = document.getElementById('popupNodeTitle');
  const info = document.getElementById('popupNodeInfo');

  title.textContent = `Nó [${key}]`;
  if (currentMode === 'AVL') {
    info.innerHTML = `Altura (h): <strong>${getHeight(nodeObj)}</strong><br/>Fator Bal. (FB): <strong>${getFB(nodeObj)}</strong>`;
  } else {
    const cor = nodeObj.color === 'RED' ? 'RUBRO (#C52613)' : 'NEGRO (#000000)';
    info.innerHTML = `Cor: <strong>${cor}</strong>`;
  }

  const wrapperRect = document.getElementById('canvasWrapper').getBoundingClientRect();
  let left = event.clientX - wrapperRect.left + 14;
  let top = event.clientY - wrapperRect.top - 20;

  if (left + 200 > wrapperRect.width) left -= 215;
  if (top + 130 > wrapperRect.height) top = wrapperRect.height - 135;
  if (top < 50) top = 50;

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
  popup.classList.remove('hidden');
}

function closeNodePopup() {
  selectedNodeKey = null;
  document.getElementById('nodePopup').classList.add('hidden');
}

function deleteSelectedNode() {
  if (selectedNodeKey === null) return;
  const keyToRemove = selectedNodeKey;
  closeNodePopup();

  saveSnapshotForUndo();
  // Garante que estamos no último frame antes de remover
  currentFrameIdx = frames.length - 1;

  if (currentMode === 'AVL') {
    deleteNodeFromAVL(keyToRemove);
  } else {
    deleteNodeFromRB(keyToRemove);
  }

  currentFrameIdx = frames.length - 1;
  renderCurrentFrame(true);
  rebuildLogList();
}

// ============================================================================
// LAYOUT E RENDERIZAÇÃO SVG ANIMADA
// ============================================================================
function computeTreeLayout(root) {
  const posMap = new Map();
  if (!root) return posMap;

  let orderIndex = 0;
  function inorder(node, depth) {
    if (!node) return;
    inorder(node.left, depth + 1);
    posMap.set(node.key, {
      x: orderIndex * 78,
      y: depth * 92,
      node: node
    });
    orderIndex++;
    inorder(node.right, depth + 1);
  }
  inorder(root, 0);

  const xs = Array.from(posMap.values()).map(p => p.x);
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
  posMap.forEach(p => { p.x -= midX; });

  return posMap;
}

function renderCurrentFrame(animate = true) {
  const frame = frames[currentFrameIdx];
  const edgesLayer = document.getElementById('edgesLayer');
  const nilLayer = document.getElementById('nilLayer');
  const nodesLayer = document.getElementById('nodesLayer');
  const overlayLayer = document.getElementById('overlayLayer');

  if (!frame || !frame.tree) {
    edgesLayer.innerHTML = '';
    nilLayer.innerHTML = '';
    nodesLayer.innerHTML = '';
    overlayLayer.innerHTML = '';
    updateSidebarStats(null);
    return;
  }

  const targetLayout = computeTreeLayout(frame.tree);

  if (!animate) {
    drawSvgScene(frame, targetLayout);
    previousPositions = new Map();
    targetLayout.forEach((v, k) => previousPositions.set(k, { x: v.x, y: v.y }));
    updateBannerAndExplanation(frame);
    updateSidebarStats(frame.tree);
    return;
  }

  const startLayout = new Map();
  targetLayout.forEach((tPos, key) => {
    if (previousPositions.has(key)) {
      startLayout.set(key, previousPositions.get(key));
    } else {
      startLayout.set(key, { x: tPos.x, y: tPos.y - 35 });
    }
  });

  const duration = 360;
  const startTime = performance.now();
  isAnimating = true;

  function animateTick(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const ease = 1 - Math.pow(1 - t, 3);

    const interpolated = new Map();
    targetLayout.forEach((tPos, key) => {
      const sPos = startLayout.get(key);
      interpolated.set(key, {
        x: sPos.x + (tPos.x - sPos.x) * ease,
        y: sPos.y + (tPos.y - sPos.y) * ease,
        node: tPos.node
      });
    });

    drawSvgScene(frame, interpolated);

    if (t < 1) {
      requestAnimationFrame(animateTick);
    } else {
      previousPositions = new Map();
      targetLayout.forEach((v, k) => previousPositions.set(k, { x: v.x, y: v.y }));
      isAnimating = false;
    }
  }

  requestAnimationFrame(animateTick);
  updateBannerAndExplanation(frame);
  updateSidebarStats(frame.tree);
}

function drawSvgScene(frame, layoutMap) {
  const edgesLayer = document.getElementById('edgesLayer');
  const nilLayer = document.getElementById('nilLayer');
  const nodesLayer = document.getElementById('nodesLayer');
  const overlayLayer = document.getElementById('overlayLayer');

  const showMeta = document.getElementById('chkShowMeta').checked;
  const showNil = document.getElementById('chkShowNil').checked;

  let edgesHtml = '';
  let nilHtml = '';
  let nodesHtml = '';
  let overlayHtml = '';

  layoutMap.forEach((pos) => {
    const n = pos.node;
    if (n.left && layoutMap.has(n.left.key)) {
      const c = layoutMap.get(n.left.key);
      edgesHtml += `<line x1="${pos.x}" y1="${pos.y}" x2="${c.x}" y2="${c.y}" stroke="${COLORS.EDGE}" stroke-width="3" />`;
    } else if (currentMode === 'RB' && showNil) {
      const nx = pos.x - 28, ny = pos.y + 52;
      nilHtml += `<line x1="${pos.x}" y1="${pos.y}" x2="${nx}" y2="${ny}" stroke="#64748b" stroke-dasharray="3,3" stroke-width="1.5" />`;
      nilHtml += `<rect x="${nx - 14}" y="${ny - 9}" width="28" height="18" rx="3" fill="#000000" />`;
      nilHtml += `<text x="${nx}" y="${ny + 3}" text-anchor="middle" fill="#ffffff" font-size="9" font-weight="700">NIL</text>`;
    }

    if (n.right && layoutMap.has(n.right.key)) {
      const c = layoutMap.get(n.right.key);
      edgesHtml += `<line x1="${pos.x}" y1="${pos.y}" x2="${c.x}" y2="${c.y}" stroke="${COLORS.EDGE}" stroke-width="3" />`;
    } else if (currentMode === 'RB' && showNil) {
      const nx = pos.x + 28, ny = pos.y + 52;
      nilHtml += `<line x1="${pos.x}" y1="${pos.y}" x2="${nx}" y2="${ny}" stroke="#64748b" stroke-dasharray="3,3" stroke-width="1.5" />`;
      nilHtml += `<rect x="${nx - 14}" y="${ny - 9}" width="28" height="18" rx="3" fill="#000000" />`;
      nilHtml += `<text x="${nx}" y="${ny + 3}" text-anchor="middle" fill="#ffffff" font-size="9" font-weight="700">NIL</text>`;
    }
  });

  layoutMap.forEach((pos, key) => {
    const n = pos.node;
    const isFocus = (frame.focusKey === key);

    let fillColor = COLORS.AVL_NODE;
    let strokeColor = COLORS.AVL_STROKE;

    if (currentMode === 'RB') {
      fillColor = (n.color === 'RED') ? COLORS.RB_RED : COLORS.RB_BLACK;
      strokeColor = (n.color === 'RED') ? '#8a1709' : '#334155';
    }

    nodesHtml += `<g class="tree-node-group" transform="translate(${pos.x}, ${pos.y})" onclick="onNodeClick(event, ${n.key}, ${pos.x}, ${pos.y})">`;

    // Aura em volta do nó (Verde se equilibrado, Vermelha se desequilibrar a árvore)
    if (isFocus) {
      const auraHex = (frame.auraColor === 'RED') ? COLORS.AURA_BAD : COLORS.AURA_OK;
      nodesHtml += `<circle r="34" fill="none" stroke="${auraHex}" stroke-width="6" class="aura-ring" />`;
    }

    nodesHtml += `<circle r="26" fill="${fillColor}" stroke="${strokeColor}" stroke-width="2.5" />`;
    nodesHtml += `<text y="6" text-anchor="middle" fill="#ffffff" font-size="15" font-weight="700">${n.key}</text>`;

    if (showMeta) {
      if (currentMode === 'AVL') {
        const fb = getFB(n);
        const h = getHeight(n);
        const fbColor = Math.abs(fb) > 1 ? '#dc2626' : '#0f172a';
        nodesHtml += `<rect x="-32" y="30" width="64" height="17" rx="4" fill="#ffffff" stroke="#94a3b8" stroke-width="1" />`;
        nodesHtml += `<text x="0" y="42" text-anchor="middle" fill="${fbColor}" font-size="10" font-weight="700">h:${h} | FB:${fb > 0 ? '+' + fb : fb}</text>`;
      } else {
        const cLabel = n.color === 'RED' ? 'RUBRO' : 'NEGRO';
        nodesHtml += `<rect x="-26" y="30" width="52" height="16" rx="4" fill="#ffffff" stroke="#94a3b8" stroke-width="1" />`;
        nodesHtml += `<text x="0" y="41" text-anchor="middle" fill="#0f172a" font-size="9.5" font-weight="700">${cLabel}</text>`;
      }
    }

    nodesHtml += `</g>`;

    if (isFocus && frame.dir) {
      const arcPath = frame.dir === 'CW'
        ? `M ${pos.x - 36} ${pos.y - 22} A 42 42 0 0 1 ${pos.x + 36} ${pos.y - 22}`
        : `M ${pos.x + 36} ${pos.y - 22} A 42 42 0 0 0 ${pos.x - 36} ${pos.y - 22}`;
      overlayHtml += `<path d="${arcPath}" fill="none" stroke="#dc2626" stroke-width="3.5" stroke-dasharray="5,3" marker-end="url(#rotArrow)" />`;
    }
  });

  edgesLayer.innerHTML = edgesHtml;
  nilLayer.innerHTML = nilHtml;
  nodesLayer.innerHTML = nodesHtml;
  overlayLayer.innerHTML = overlayHtml;
}

// ============================================================================
// ALTERNÂNCIA DE MODO, AUTO PLAY E PAINEL LATERAL
// ============================================================================
function switchTreeMode(mode) {
  if (currentMode === mode) return;
  saveSnapshotForUndo();
  stopAutoPlay();
  closeNodePopup();

  currentMode = mode;
  document.getElementById('btnModeAVL').classList.toggle('active', mode === 'AVL');
  document.getElementById('btnModeRB').classList.toggle('active', mode === 'RB');
  document.getElementById('lblShowNil').classList.toggle('hidden', mode !== 'RB');

  avlRoot = null;
  rbRoot = null;
  frames = [];
  currentFrameIdx = -1;
  totalRotations = 0;
  totalRecolors = 0;
  previousPositions.clear();

  updateRulesBox();
  renderQueueBar();
  renderCurrentFrame(false);
  rebuildLogList();
}

function updateRulesBox() {
  const title = document.getElementById('rulesTitle');
  const content = document.getElementById('rulesContent');

  if (currentMode === 'AVL') {
    title.textContent = 'Regras de Balanceamento (AVL)';
    content.innerHTML = `
      <ul>
        <li><strong>Fator de Balanceamento:</strong> FB = h(dir) − h(esq).</li>
        <li><strong>Condição AVL:</strong> Todo nó deve ter FB ∈ {-1, 0, +1}.</li>
        <li><strong>Aura Verde:</strong> Nó inserido sem violar |FB| ≤ 1.</li>
        <li><strong>Aura Vermelha:</strong> Inserção gerou |FB| = 2 (requer rotação LL, RR, LR ou RL).</li>
      </ul>
    `;
  } else {
    title.textContent = 'As 5 Propriedades (Rubro-Negra)';
    content.innerHTML = `
      <ul>
        <li><strong>1.</strong> Todo nó é RUBRO (<code>#C52613</code>) ou NEGRO (<code>#000000</code>).</li>
        <li><strong>2.</strong> A raiz é sempre NEGRA.</li>
        <li><strong>3.</strong> Toda folha NIL é NEGRA.</li>
        <li><strong>4.</strong> Pai de nó RUBRO é NEGRO (sem 2 rubros seguidos).</li>
        <li><strong>5.</strong> Altura-negra constante até qualquer folha NIL.</li>
      </ul>
    `;
  }
}

function updateBannerAndExplanation(frame) {
  const banner = document.getElementById('actionBanner');
  const badge = document.getElementById('bannerBadge');
  banner.classList.remove('hidden');

  badge.textContent = frame.badge;
  badge.className = 'banner-badge ' + (frame.auraColor === 'RED' ? 'bad' : 'ok');
  document.getElementById('bannerText').textContent = frame.banner;
  document.getElementById('stepExplanation').innerHTML = frame.explanation;
}

function updateSidebarStats(tree) {
  document.getElementById('statMode').textContent = currentMode === 'AVL' ? 'Árvore AVL' : 'Rubro-Negra';
  document.getElementById('statCount').textContent = countNodes(tree);
  document.getElementById('statHeight').textContent = getHeight(tree);

  const extraLabel = document.getElementById('statExtraLabel');
  const extraVal = document.getElementById('statExtraVal');

  if (currentMode === 'AVL') {
    const f = frames[currentFrameIdx];
    extraLabel.textContent = 'Total de Rotações';
    extraVal.textContent = f && f.rotationsCount !== undefined ? f.rotationsCount : totalRotations;
  } else {
    const bh = tree ? getBlackHeight(tree) : 0;
    extraLabel.textContent = 'Altura-Negra (bh)';
    extraVal.textContent = bh;
  }
}

function rebuildLogList() {
  const list = document.getElementById('historyList');
  const counter = document.getElementById('historyCounter');
  const visibleFrames = frames.slice(0, currentFrameIdx + 1);

  counter.textContent = `${visibleFrames.length} eventos`;
  list.innerHTML = visibleFrames
    .map((f, i) => {
      let cls = 'log-entry';
      if (f.auraColor === 'RED') cls += ' bad';
      else if (f.type === 'ROTATE_DONE') cls += ' rot';
      return `<div class="${cls}"><strong>#${i + 1} [${f.badge}]</strong><br/>${f.banner}</div>`;
    })
    .reverse()
    .join('');
}

function toggleAutoPlay() {
  if (autoPlayTimer) {
    stopAutoPlay();
  } else {
    const btn = document.getElementById('btnAutoPlay');
    btn.textContent = '⏸ Pausar';
    btn.classList.add('playing');
    const loop = () => {
      if (currentFrameIdx >= frames.length - 1 && pendingQueue.length === 0) {
        stopAutoPlay();
        return;
      }
      stepManual();
      const delay = parseInt(document.getElementById('speedRange').value, 10);
      autoPlayTimer = setTimeout(loop, delay);
    };
    loop();
  }
}

function stopAutoPlay() {
  if (autoPlayTimer) {
    clearTimeout(autoPlayTimer);
    autoPlayTimer = null;
  }
  const btn = document.getElementById('btnAutoPlay');
  btn.textContent = '▶ Auto Play';
  btn.classList.remove('playing');
}

// ============================================================================
// EXPORTAÇÃO MULTIFORMATO (SVG, PNG, JPEG, PDF)
// ============================================================================
function getPreparedSvgString() {
  const svgElem = document.getElementById('treeSvg');
  const rect = svgElem.getBoundingClientRect();
  const clone = svgElem.cloneNode(true);

  clone.setAttribute('width', rect.width);
  clone.setAttribute('height', rect.height);
  clone.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);

  // Adiciona fundo sólido #d9d9d9 diretamente ao SVG exportado
  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bgRect.setAttribute('width', '100%');
  bgRect.setAttribute('height', '100%');
  bgRect.setAttribute('fill', '#d9d9d9');
  clone.insertBefore(bgRect, clone.firstChild);

  const serializer = new XMLSerializer();
  return {
    svgString: serializer.serializeToString(clone),
    width: rect.width,
    height: rect.height
  };
}

function exportTree() {
  const format = document.getElementById('exportFormat').value;
  const { svgString, width, height } = getPreparedSvgString();
  const baseName = `arvore_${currentMode.toLowerCase()}`;

  if (format === 'svg') {
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `${baseName}.svg`);
    URL.revokeObjectURL(url);
    return;
  }

  // Renderiza o SVG num Canvas HTML5 de alta resolução (2x) para PNG, JPEG ou PDF
  const img = new Image();
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  img.onload = function () {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#d9d9d9';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(url);

    if (format === 'png') {
      triggerDownload(canvas.toDataURL('image/png'), `${baseName}.png`);
    } else if (format === 'jpeg') {
      triggerDownload(canvas.toDataURL('image/jpeg', 0.95), `${baseName}.jpg`);
    } else if (format === 'pdf') {
      const imgData = canvas.toDataURL('image/png');
      if (window.jspdf && window.jspdf.jsPDF) {
        const orientation = width >= height ? 'l' : 'p';
        const pdf = new window.jspdf.jsPDF(orientation, 'pt', [width, height]);
        pdf.addImage(imgData, 'PNG', 0, 0, width, height);
        pdf.save(`${baseName}.pdf`);
      }
    }
  };
  img.src = url;
}

function triggerDownload(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ============================================================================
// CÂMERA E ATALHOS DE TECLADO (INCLUINDO CTRL + Z)
// ============================================================================
function applyCameraTransform() {
  const svg = document.getElementById('treeSvg');
  const rect = svg.getBoundingClientRect();
  const cx = rect.width / 2 + cam.x;
  const cy = 70 + cam.y;
  document.getElementById('viewportGroup').setAttribute(
    'transform',
    `translate(${cx}, ${cy}) scale(${cam.scale})`
  );
}

function zoomCanvas(factor) {
  cam.scale = Math.max(0.35, Math.min(2.5, cam.scale * factor));
  applyCameraTransform();
}

function resetCamera() {
  cam = { x: 0, y: 55, scale: 1 };
  applyCameraTransform();
}

window.addEventListener('DOMContentLoaded', () => {
  updateRulesBox();
  renderQueueBar();
  updateUndoButtonUI();
  resetCamera();

  const svg = document.getElementById('treeSvg');
  svg.addEventListener('mousedown', e => {
    if (e.target.closest('.tree-node-group')) return;
    closeNodePopup();
    isDragging = true;
    dragStart = { x: e.clientX - cam.x, y: e.clientY - cam.y };
  });

  window.addEventListener('mousemove', e => {
    if (!isDragging) return;
    cam.x = e.clientX - dragStart.x;
    cam.y = e.clientY - dragStart.y;
    applyCameraTransform();
  });

  window.addEventListener('mouseup', () => { isDragging = false; });

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    zoomCanvas(e.deltaY < 0 ? 1.1 : 0.9);
  }, { passive: false });

  document.getElementById('inputValues').addEventListener('keydown', e => {
    if (e.key === 'Enter') insertDirectManualFromInput();
  });

  // Atalho global Ctrl + Z para desfazer passo
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      e.preventDefault();
      undoStep();
    }
  });

  window.addEventListener('resize', applyCameraTransform);
});