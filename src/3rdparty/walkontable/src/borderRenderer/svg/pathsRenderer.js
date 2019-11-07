import svgOptimizePath from './optimizePath';

let stringifyPath;

/**
 * getSvgPathsRenderer is a higher-order function that returns a function to render paths.
 *
 * `styles` is an array of stroke style strings, e.g.:
 * [
 *   '1px black',
 *   '2px #FF0000'
 * ]
 *
 * `commands` is an array of path commands strings for each style, e.g.:
 * [
 *   'M 0 0 L 0 10',
 *   'M 50 0 L 50 20'
 * ]
 *
 * Assumptions:
 *  - the length of `styles` and `commands` must be the same
 *
 * @param {HTMLElement} svg <svg> or <g> element
 * @returns {Function}
 */
export default function getSvgPathsRenderer(svg) {
  if (!stringifyPath) {
    stringifyPath = hasImplicitLineProblem(svg.ownerDocument) ? stringifyPathExplicit : stringifyPathImplicit;
  }

  svg.setAttribute('fill', 'none');

  /**
   * Map of states for each <path> element, where the key is `style` and the value is the state object
   *
   * @type {Map.<string, Object>}
   */
  const states = new Map();

  return (styles, commands) => {
    states.forEach(resetState);

    for (let ii = 0; ii < styles.length; ii++) { // http://jsbench.github.io/#fb2e17228039ba5bfdf4d1744395f352
      const state = getStateForStyle(states, styles[ii], svg);

      state.command = commands[ii];
    }

    states.forEach(renderState);
  };
}

/**
 * For a given `style` string returns a relevant array from the `stylesAndLines` map.
 * Sets a new array in `stylesAndLines` if an existing one is not found.
 *
 * @param {Map.<string, Array.<Array.<number>>>} stylesAndLines Map where keys are the `style` strings and values are lines in format `[[x1, y1, x2, y2, ...], ...]`
 * @param {String} style Stroke style description, e.g. `1px black`
 * @returns {Array.<Array.<number>>} Lines in format `[[x1, y1, x2, y2, ...], ...]`
 */
function getLines(stylesAndLines, style) {
  const lines = stylesAndLines.get(style);

  if (lines) {
    return lines;
  }

  const newLines = [];

  stylesAndLines.set(style, newLines);

  return newLines;
}

/**
 * For a given configuration object (as described in Handsontable `CustomBorders` plugin) returns a relevant `stylesAndLines` map.
 *
 * @param {Array.<Object>} rawData Configuration object
 * @returns {Map.<string, Array.<Array.<string>>>} Map where keys are the `style` strings and values are SVG Path commands in format `['M x1 y1 x2 y2 ... Z', ...]`
 */
export function precalculateStylesAndCommands(rawData) {
  const stylesAndLines = new Map();
  const stylesAndCommands = new Map();

  for (let ii = 0; ii < rawData.length; ii++) {
    const { x1, y1, x2, y2, topStyle, rightStyle, bottomStyle, leftStyle } = rawData[ii];

    if (topStyle) {
      const lines = getLines(stylesAndLines, topStyle);

      lines.push([x1, y1, x2, y1]);
    }
    if (rightStyle) {
      const lines = getLines(stylesAndLines, rightStyle);

      lines.push([x2, y1, x2, y2]);
    }
    if (bottomStyle) {
      const lines = getLines(stylesAndLines, bottomStyle);

      lines.push([x1, y2, x2, y2]);
    }
    if (leftStyle) {
      const lines = getLines(stylesAndLines, leftStyle);

      lines.push([x1, y1, x1, y2]);
    }
  }

  const styles = [...stylesAndLines.keys()];

  styles.forEach((style) => {
    const lines = stylesAndLines.get(style);
    const strokeWidth = parseInt(style, 10);
    const adjustedLines = adjustLinesToViewBox(strokeWidth, lines);
    const optimizedLines = svgOptimizePath(adjustedLines);
    const command = convertLinesToCommand(optimizedLines, strokeWidth);

    stylesAndCommands.set(style, command);
  });

  return stylesAndCommands;
}

/**
 * Prepares the state object for the next rendering
 *
 * @param {Object} state
 */
function resetState(state) {
  state.command = '';
}

/**
 * Renders the <path> element in the state object to DOM and memoizes the current path
 *
 * @param {Object} state
 */
function renderState(state) {
  if (state.renderedCommand !== state.command) {
    state.elem.setAttribute('d', state.command);
    state.renderedCommand = state.command;
  }
}

/**
 * High stroke sizes have priority over small sizes. Horizontal lines have priority over vertical ones.
 *
 * @param {string} style1
 * @param {string} style2
 * @returns {Number} 1 if path1 has a higher priority than path2, 0 if path1 has the same priority as path2, -1 if path1 has a lower priority than path2
 */
export function compareStrokePriority(style1, style2) {
  const splitStyle1 = style1.split(' ');
  const size1 = splitStyle1[0];
  const direction1 = splitStyle1[2];
  const splitStyle2 = style2.split(' ');
  const size2 = splitStyle2[0];
  const direction2 = splitStyle2[2];

  if (size1 > size2) {
    return 1;
  }
  if (size1 < size2) {
    return -1;
  }

  const isHorizontal1 = direction1 === 'horizontal';
  const isHorizontal2 = direction2 === 'horizontal';

  if (isHorizontal1 && isHorizontal2) {
    return 0;
  }
  if (isHorizontal1) {
    return 1;
  }
  return -1;
}

/**
 * Returns a state object for given style. Creates the state object if requested for the first time.
 *
 * @param {Map.<string, Object>} states
 * @param {String} style Stroke style description in format `width color direction`, e.g. `1px black horizontal`
 * @param {HTMLElement} parent <svg> or <g> HTML element where the <path> elements should be appended
 */
function getStateForStyle(states, style, parent) {
  let state = states.get(style);

  if (!state) {
    const elem = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
    const [size, color] = style.split(' ');

    elem.setAttribute('stroke', color);
    elem.setAttribute('stroke-width', parseInt(size, 10));
    // elem.setAttribute('stroke-linecap', 'square'); // default: butt
    // elem.setAttribute('shape-rendering', 'optimizeSpeed');
    elem.setAttribute('shape-rendering', 'geometricPrecision'); // TODO why the border renders wrong when this is on
    // elem.setAttribute('shape-rendering', 'crispEdges');
    elem.dataset.strokeStyle = style;

    state = {
      elem,
      command: '',
      renderedCommand: ''
    };
    resetState(state);

    let insertBeforeElem = null;
    let siblingElem = parent.firstElementChild;
    while (siblingElem) {
      if (compareStrokePriority(elem.dataset.strokeStyle, siblingElem.dataset.strokeStyle) === -1) {
        insertBeforeElem = siblingElem;
        break;
      }
      siblingElem = siblingElem.nextSibling;
    }
    if (insertBeforeElem) {
      parent.insertBefore(elem, insertBeforeElem);
    } else {
      parent.appendChild(elem);
    }

    states.set(style, state);
  }

  return state;
}

/**
 * Adjusts all line coordinates to fit within the SVG image
 *
 * `lines` is an array of `x1`, `y1`, `x2`, `y2` quadruplets, e.g.:
 * [
 *   [0, 0, 10, 10, 0, 0, 10, 0, 20, 20, 50, 50],
 *   [5, 5, 55, 5]
 * ]
 *
 * Assumptions:
 *  - `(x1 >= 0 || x2 >= 0) && (y1 >= 0 || y2 >= 0)`
 *  - `x1 <= x2 && y1 <= y2`
 *  - `x1 === x2 || y1 === y2`
 *
 * @param {Number} strokeWidth The width of the stroke in pixels
 * @param {Array.<Array.<number>>>} lines SVG Path data in format `[[x1, y1, x2, y2], ...]`
 */
export function adjustLinesToViewBox(strokeWidth, lines) {
  const newLines = new Array(lines.length);
  const needSubPixelCorrection = (strokeWidth % 2 !== 0); // disable antialiasing

  for (let ii = 0; ii < lines.length; ii++) {
    let [x1, y1, x2, y2] = lines[ii];

    if (needSubPixelCorrection) {
      const isHorizontal = y1 === y2;
      if (isHorizontal) {
        y1 += 0.5;
        y2 += 0.5;
      } else {
        x1 += 0.5;
        x2 += 0.5;
      }
    }

    newLines[ii] = [x1, y1, x2, y2];
  }

  return newLines;
}

/**
 * Stringify line using explicit definition of each segment in a poly-line
 * @param {Array.<number>} line
 * @returns {String}
 */
function stringifyPathExplicit(line) {
  let command = 'M ';

  for (let jj = 0; jj < line.length; jj++) {
    if (jj > 1 && (jj % 2 === 0)) {
      command += ` L ${line[jj]}`;
    } else {
      command += ` ${line[jj]}`;
    }
  }

  return command;
}

/**
 * Stringify line using implicit definition of each segment in a poly-line
 * @param {Array.<number>} line
 * @returns {String}
 */
function stringifyPathImplicit(line) {
  return `M ${line.join(' ')}`;
}

/**
 * Some browsers (Edge) convert implicit lines "M 0 0 10 0" into explicit lines "M 0 0 L 10 0". Detect if this is such browser
 * @param {Object} document DOM document object
 * @returns {Boolean}
 */
export function hasImplicitLineProblem(document) {
  const desiredCommand = 'M 0 0 10 0';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

  path.setAttribute('d', desiredCommand);

  return desiredCommand !== path.getAttribute('d');
}

/**
 * Convert array of positions to a SVG Path command string
 *
 * @param {Array.<Array.<number>>>} lines SVG Path data in format `[[x1, y1, x2, y2, ...], ...]`
 * @returns {String}
 */
export function convertLinesToCommand(lines, strokeWidth) {
  let command = '';
  let firstX = -1;
  let firstY = -1;
  let lastX = -1;
  let lastY = -1;

  for (let ii = 0; ii < lines.length; ii++) {
    const line = lines[ii];

    if (ii === 0) {
      firstX = line[0];
      firstY = line[1];
    }

    const len = line.length;

    lastX = line[len - 2];
    lastY = line[len - 1];

    if (ii > 0) {
      command += ' ';
    }

    command += stringifyPath(line);
  }

  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  const isLastPointDifferentThanFirst = (firstX !== lastX || firstY !== lastY);

  if (isLastPointDifferentThanFirst) {
    if (strokeWidth === 1) {
      const lastLineLen = lastLine.length;

      command = `M ${firstLine[2]} ${firstLine[3]} ${command.substring(2)} ${lastLine[lastLineLen - 4]} ${lastLine[lastLineLen - 3]}`;
    }
  } else {
    command += ' Z';
  }

  return command;
}
