/**
 * Authored pixel art + per-archetype sheet builder for the GasView visual
 * agents plugin (split out of scripts/sprites/generate.mjs for the push-size
 * cap; generated output is byte-identical).
 *
 * STABLE INTERFACE consumed by scripts/sprites/generate.mjs:
 *   export function sheets(): Array<{ file: string, exports: [string, object][] }>
 * Each entry names one output file under
 * packages/client-ui-agent-team-visual/src/assets/sprites/ and the
 * [exportName, SpriteSheetData] pairs serialized into it. Sheet data uses the
 * legend below ('.' transparent, X ink, w darkWood, m muted, b brass,
 * z bronze, c copper, s steel, r oxide, h highlight, p parchment,
 * P surface, t tint slot).
 */

// reviewer (48x48, fps 6): badger-INSPIRED clerk — darkwood ears/eye-stripes
//   over a steel face with a surface badger mask, tint clerk vest with a
//   surface belly patch, bronze satchel on a cross-chest strap, steel trousers,
//   darkwood boots. Idle: belly breathing + one blink frame + mouth frame.
//   Work: writing on a parchment ledger with a steel pen (pen writes/lifts at
//   alternating x positions). Walk: same 48px leg/bob scheme as the teammate
//   walk plus a satchel sway on the bob frames.
// Big head (~45% height), 1px ink outlines, warm top-left highlight pixels.

const LEGEND = {
  '.': null, X: 'ink', w: 'darkWood', m: 'muted', b: 'brass', z: 'bronze',
  c: 'copper', s: 'steel', r: 'oxide', h: 'highlight', p: 'parchment',
  P: 'surface', t: 'copper',
}

// ---------------------------------------------------------------------------
// Authored pixel maps (the art lives here).
// ---------------------------------------------------------------------------

const REVIEWER_IDLE = [
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhwX....................XwwX..........',
    '.........XwwwwX..................XwwwwX.........',
    '.........XwwwwXXXXXXXXXXXXXXXXXXXXwwwwX.........',
    '.........XwhsssssssssssssssssssssssssswX........',
    '.........XssssssssssssssssssssssssssssssX.......',
    '.........XsssssPPPPPPPssssPPPPPPPssssssX........',
    '.........XsssPPPPPPPPPPssPPPPPPPPPPssssX........',
    '.........XsPPPwwwPPPPPPPPPPPPwwwPPPssssX........',
    '.........XsPPPwXwPPPPPPPPPPPPPPwXwPPPssX........',
    '.........XsPPPwwwPPPPPPPPPPPPPPwwwPPPssX........',
    '.........XssPPPwPPPPPPPPPPPPPPPPwPPPsssX........',
    '.........XssPPPPPPPPPPXXPPPPPPPPPPssssX.........',
    '.........XssPPPPPPPPPXXXXPPPPPPPPPssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '..........XsssPPPPPPPXXPPPPPPPPPPPssssX.........',
    '..........XssssPPPPPPPPPPPPPPPPPPPsssX..........',
    '...........XXsssssPPPPPPPPPPPPPPPPsssXX.........',
    '............XssssssPPPPPPPPPPPPPPPsssX..........',
    '.............XssssssPPPPPPPPPPPPPPssXX..........',
    '..........XXXXhttttttttttttttttttXXXX...........',
    '.........XhwwttttttttttttttttttttttwwwX.........',
    '.........XwwttttttttttttttttttttzztwwwX.........',
    '.........XwtttttttttttttttttzztttttwwwX.........',
    '.........XwtttttttttttttzztttttttttwwwX.........',
    '.........XwttttttttPzzPPPPPPPPPPPttwwwX.........',
    '.........XwtttttzzPPPPPPPPPPPPPPPttwwwX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPttwwwX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPtppppX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPtppppX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPtppppX.........',
    '......XzzzXXttttttPPPPPPPPPPPPPPPtttX...........',
    '.....XzzzzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzbzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzzzzzX.XXsssssssXXsssssssXX..............',
    '.....XzzzzzzX..XsssssssXXsssssssX...............',
    '......XXXXX....XsssssssXXsssssssX...............',
    '...............XsssssssXXsssssssX...............',
    '..............XXsssssssXXsssssssXX..............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhwX....................XwwX..........',
    '.........XwwwwX..................XwwwwX.........',
    '.........XwwwwXXXXXXXXXXXXXXXXXXXXwwwwX.........',
    '.........XwhsssssssssssssssssssssssssswX........',
    '.........XssssssssssssssssssssssssssssssX.......',
    '.........XsssssPPPPPPPssssPPPPPPPssssssX........',
    '.........XsssPPPPPPPPPPssPPPPPPPPPPssssX........',
    '.........XsPPPwwwPPPPPPPPPPPPwwwPPPssssX........',
    '.........XsPPPwXwPPPPPPPPPPPPPPwXwPPPssX........',
    '.........XsPPPwwwPPPPPPPPPPPPPPwwwPPPssX........',
    '.........XssPPPwPPPPPPPPPPPPPPPPwPPPsssX........',
    '.........XssPPPPPPPPPPXXPPPPPPPPPPssssX.........',
    '.........XssPPPPPPPPPXXXXPPPPPPPPPssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '..........XsssPPPPPPPXXPPPPPPPPPPPssssX.........',
    '..........XssssPPPPPPPPPPPPPPPPPPPsssX..........',
    '...........XXsssssPPPPPPPPPPPPPPPPsssXX.........',
    '............XssssssPPPPPPPPPPPPPPPsssX..........',
    '.............XssssssPPPPPPPPPPPPPPssXX..........',
    '..........XXXXhttttttttttttttttttXXXX...........',
    '.........XhwwttttttttttttttttttttttwwwX.........',
    '.........XwwttttttttttttttttttttzztwwwX.........',
    '.........XwtttttttttttttttttzztttttwwwX.........',
    '.........XwtttttttttttttzztttttttttwwwX.........',
    '.........XwttttttttPzzPPPPPPPPPPPttwwwX.........',
    '.........XwtttttzzPPPPPPPPPPPPPPPttwwwX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPttwwwX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPtppppX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPtppppX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPtppppX.........',
    '......XzzzXXtttttPPPPPPPPPPPPPPPPPtttX..........',
    '.....XzzzzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzbzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzzzzzX.XXsssssssXXsssssssXX..............',
    '.....XzzzzzzX..XsssssssXXsssssssX...............',
    '......XXXXX....XsssssssXXsssssssX...............',
    '...............XsssssssXXsssssssX...............',
    '..............XXsssssssXXsssssssXX..............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhwX....................XwwX..........',
    '.........XwwwwX..................XwwwwX.........',
    '.........XwwwwXXXXXXXXXXXXXXXXXXXXwwwwX.........',
    '.........XwhsssssssssssssssssssssssssswX........',
    '.........XssssssssssssssssssssssssssssssX.......',
    '.........XsssssPPPPPPPssssPPPPPPPssssssX........',
    '.........XsssPPPPPPPPPPssPPPPPPPPPPssssX........',
    '.........XsPPPwwwPPPPPPPPPPPPwwwPPPssssX........',
    '.........XsPPPwwwPPPPPPPPPPPPPPwwwPPPssX........',
    '.........XsPPPwwwPPPPPPPPPPPPPPwwwPPPssX........',
    '.........XssPPPwPPPPPPPPPPPPPPPPwPPPsssX........',
    '.........XssPPPPPPPPPPXXPPPPPPPPPPssssX.........',
    '.........XssPPPPPPPPPXXXXPPPPPPPPPssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '..........XsssPPPPPPPXXPPPPPPPPPPPssssX.........',
    '..........XssssPPPPPPPPPPPPPPPPPPPsssX..........',
    '...........XXsssssPPPPPPPPPPPPPPPPsssXX.........',
    '............XssssssPPPPPPPPPPPPPPPsssX..........',
    '.............XssssssPPPPPPPPPPPPPPssXX..........',
    '..........XXXXhttttttttttttttttttXXXX...........',
    '.........XhwwttttttttttttttttttttttwwwX.........',
    '.........XwwttttttttttttttttttttzztwwwX.........',
    '.........XwtttttttttttttttttzztttttwwwX.........',
    '.........XwtttttttttttttzztttttttttwwwX.........',
    '.........XwttttttttPzzPPPPPPPPPPPttwwwX.........',
    '.........XwtttttzzPPPPPPPPPPPPPPPttwwwX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPttwwwX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPtppppX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPtppppX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPtppppX.........',
    '......XzzzXXttttttPPPPPPPPPPPPPPPtttX...........',
    '.....XzzzzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzbzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzzzzzX.XXsssssssXXsssssssXX..............',
    '.....XzzzzzzX..XsssssssXXsssssssX...............',
    '......XXXXX....XsssssssXXsssssssX...............',
    '...............XsssssssXXsssssssX...............',
    '..............XXsssssssXXsssssssXX..............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhwX....................XwwX..........',
    '.........XwwwwX..................XwwwwX.........',
    '.........XwwwwXXXXXXXXXXXXXXXXXXXXwwwwX.........',
    '.........XwhsssssssssssssssssssssssssswX........',
    '.........XssssssssssssssssssssssssssssssX.......',
    '.........XsssssPPPPPPPssssPPPPPPPssssssX........',
    '.........XsssPPPPPPPPPPssPPPPPPPPPPssssX........',
    '.........XsPPPwwwPPPPPPPPPPPPwwwPPPssssX........',
    '.........XsPPPwXwPPPPPPPPPPPPPPwXwPPPssX........',
    '.........XsPPPwwwPPPPPPPPPPPPPPwwwPPPssX........',
    '.........XssPPPwPPPPPPPPPPPPPPPPwPPPsssX........',
    '.........XssPPPPPPPPPPXXPPPPPPPPPPssssX.........',
    '.........XssPPPPPPPPPXXXXPPPPPPPPPssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '.........XsssPPPPPPPPXpPXPPPPPPPPsssssX.........',
    '..........XsssPPPPPPPXXPPPPPPPPPPPssssX.........',
    '..........XssssPPPPPPPPPPPPPPPPPPPsssX..........',
    '...........XXsssssPPPPPPPPPPPPPPPPsssXX.........',
    '............XssssssPPPPPPPPPPPPPPPsssX..........',
    '.............XssssssPPPPPPPPPPPPPPssXX..........',
    '..........XXXXhttttttttttttttttttXXXX...........',
    '.........XhwwttttttttttttttttttttttwwwX.........',
    '.........XwwttttttttttttttttttttzztwwwX.........',
    '.........XwtttttttttttttttttzztttttwwwX.........',
    '.........XwtttttttttttttzztttttttttwwwX.........',
    '.........XwttttttttPzzPPPPPPPPPPPttwwwX.........',
    '.........XwtttttzzPPPPPPPPPPPPPPPttwwwX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPttwwwX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPtppppX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPtppppX.........',
    '.........XwpppttttPPPPPPPPPPPPPPPtppppX.........',
    '......XzzzXXttttttPPPPPPPPPPPPPPPtttX...........',
    '.....XzzzzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzbzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzzzzzX.XXsssssssXXsssssssXX..............',
    '.....XzzzzzzX..XsssssssXXsssssssX...............',
    '......XXXXX....XsssssssXXsssssssX...............',
    '...............XsssssssXXsssssssX...............',
    '..............XXsssssssXXsssssssXX..............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
]

const REVIEWER_WORK = [
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhwX....................XwwX..........',
    '.........XwwwwX..................XwwwwX.........',
    '.........XwwwwXXXXXXXXXXXXXXXXXXXXwwwwX.........',
    '.........XwhsssssssssssssssssssssssssswX........',
    '.........XssssssssssssssssssssssssssssssX.......',
    '.........XsssssPPPPPPPssssPPPPPPPssssssX........',
    '.........XsssPPPPPPPPPPssPPPPPPPPPPssssX........',
    '.........XsPPPwwwPPPPPPPPPPPPwwwPPPssssX........',
    '.........XsPPPwXwPPPPPPPPPPPPPPwXwPPPssX........',
    '.........XsPPPwwwPPPPPPPPPPPPPPwwwPPPssX........',
    '.........XssPPPwPPPPPPPPPPPPPPPPwPPPsssX........',
    '.........XssPPPPPPPPPPXXPPPPPPPPPPssssX.........',
    '.........XssPPPPPPPPPXXXXPPPPPPPPPssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '..........XsssPPPPPPPXXPPPPPPPPPPPssssX.........',
    '..........XssssPPPPPPPPPPPPPPPPPPPsssX..........',
    '...........XXsssssPPPPPPPPPPPPPPPPsssXX.........',
    '............XssssssPPPPPPPPPPPPPPPsssX..........',
    '.............XssssssPPPPPPPPPPPPPPssXX..........',
    '..........XXXXhttttttttttttttttttXXXX...........',
    '.........XhwwttttttttttttttttttttttwwwX.........',
    '.........XwwttttttttttwwwwwwttttzztwwwX.........',
    '.........XwtttttttttwwttttttzztttttwwwX.........',
    '........XXXXXXXXXXXswwXXXXPPPPPPPttwwwX.........',
    '........XhpppppppppspppppXPPPPPPPttwwwX.........',
    '........XpppwwwwpppspppppXPPPPPPPttwwwX.........',
    '........XppppppppppspppppXPPPPPPPttwwwX.........',
    '........XppwwwwwpppXpppppXPPPPPPPttwwwX.........',
    '........XppppppppppppppppXPPPPPPPttwwwX.........',
    '........XppppppppppppppppXPPPPPPPttwwwX.........',
    '........XXXXXXXXXXXXXXXXXXPPPPPPPtttX...........',
    '.....XzzzzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzbzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzzzzzX.XXsssssssXXsssssssXX..............',
    '.....XzzzzzzX..XsssssssXXsssssssX...............',
    '......XXXXX....XsssssssXXsssssssX...............',
    '...............XsssssssXXsssssssX...............',
    '..............XXsssssssXXsssssssXX..............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhwX....................XwwX..........',
    '.........XwwwwX..................XwwwwX.........',
    '.........XwwwwXXXXXXXXXXXXXXXXXXXXwwwwX.........',
    '.........XwhsssssssssssssssssssssssssswX........',
    '.........XssssssssssssssssssssssssssssssX.......',
    '.........XsssssPPPPPPPssssPPPPPPPssssssX........',
    '.........XsssPPPPPPPPPPssPPPPPPPPPPssssX........',
    '.........XsPPPwwwPPPPPPPPPPPPwwwPPPssssX........',
    '.........XsPPPwXwPPPPPPPPPPPPPPwXwPPPssX........',
    '.........XsPPPwwwPPPPPPPPPPPPPPwwwPPPssX........',
    '.........XssPPPwPPPPPPPPPPPPPPPPwPPPsssX........',
    '.........XssPPPPPPPPPPXXPPPPPPPPPPssssX.........',
    '.........XssPPPPPPPPPXXXXPPPPPPPPPssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '..........XsssPPPPPPPXXPPPPPPPPPPPssssX.........',
    '..........XssssPPPPPPPPPPPPPPPPPPPsssX..........',
    '...........XXsssssPPPPPPPPPPPPPPPPsssXX.........',
    '............XssssssPPPPPPPPPPPPPPPsssX..........',
    '.............XssssssPPPPPPPPPPPPPPssXX..........',
    '..........XXXXhttttttttttttttttttXXXX...........',
    '.........XhwwtttttttttttwwwwwwwwtttwwwX.........',
    '.........XwwtttttttttttswwttttttzztwwwX.........',
    '.........XwtttttttttttstttttzztttttwwwX.........',
    '........XXXXXXXXXXXXXsXXXXPPPPPPPttwwwX.........',
    '........XhppppppppppXppppXPPPPPPPttwwwX.........',
    '........XpppwwwwpppppppppXPPPPPPPttwwwX.........',
    '........XppppppppppppppppXPPPPPPPttwwwX.........',
    '........XppwwwwwpppppppppXPPPPPPPttwwwX.........',
    '........XppppppppppppppppXPPPPPPPttwwwX.........',
    '........XppppppppppppppppXPPPPPPPttwwwX.........',
    '........XXXXXXXXXXXXXXXXXXPPPPPPPtttX...........',
    '.....XzzzzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzbzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzzzzzX.XXsssssssXXsssssssXX..............',
    '.....XzzzzzzX..XsssssssXXsssssssX...............',
    '......XXXXX....XsssssssXXsssssssX...............',
    '...............XsssssssXXsssssssX...............',
    '..............XXsssssssXXsssssssXX..............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhwX....................XwwX..........',
    '.........XwwwwX..................XwwwwX.........',
    '.........XwwwwXXXXXXXXXXXXXXXXXXXXwwwwX.........',
    '.........XwhsssssssssssssssssssssssssswX........',
    '.........XssssssssssssssssssssssssssssssX.......',
    '.........XsssssPPPPPPPssssPPPPPPPssssssX........',
    '.........XsssPPPPPPPPPPssPPPPPPPPPPssssX........',
    '.........XsPPPwwwPPPPPPPPPPPPwwwPPPssssX........',
    '.........XsPPPwXwPPPPPPPPPPPPPPwXwPPPssX........',
    '.........XsPPPwwwPPPPPPPPPPPPPPwwwPPPssX........',
    '.........XssPPPwPPPPPPPPPPPPPPPPwPPPsssX........',
    '.........XssPPPPPPPPPPXXPPPPPPPPPPssssX.........',
    '.........XssPPPPPPPPPXXXXPPPPPPPPPssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '..........XsssPPPPPPPXXPPPPPPPPPPPssssX.........',
    '..........XssssPPPPPPPPPPPPPPPPPPPsssX..........',
    '...........XXsssssPPPPPPPPPPPPPPPPsssXX.........',
    '............XssssssPPPPPPPPPPPPPPPsssX..........',
    '.............XssssssPPPPPPPPPPPPPPssXX..........',
    '..........XXXXhttttttttttttttttttXXXX...........',
    '.........XhwwttttttttttttttttttttttwwwX.........',
    '.........XwwttttttwwwwwwttttttttzztwwwX.........',
    '.........XwtttttwwttttttttttzztttttwwwX.........',
    '........XXXXXXXswwXXXXXXXXPPPPPPPttwwwX.........',
    '........XhpppppspppppppppXPPPPPPPttwwwX.........',
    '........XpppwwwspppppppppXPPPPPPPttwwwX.........',
    '........XppppppspppppppppXPPPPPPPttwwwX.........',
    '........XppwwwwXpppppppppXPPPPPPPttwwwX.........',
    '........XppppppppppppppppXPPPPPPPttwwwX.........',
    '........XppppppppppppppppXPPPPPPPttwwwX.........',
    '........XXXXXXXXXXXXXXXXXXPPPPPPPtttX...........',
    '.....XzzzzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzbzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzzzzzX.XXsssssssXXsssssssXX..............',
    '.....XzzzzzzX..XsssssssXXsssssssX...............',
    '......XXXXX....XsssssssXXsssssssX...............',
    '...............XsssssssXXsssssssX...............',
    '..............XXsssssssXXsssssssXX..............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhwX....................XwwX..........',
    '.........XwwwwX..................XwwwwX.........',
    '.........XwwwwXXXXXXXXXXXXXXXXXXXXwwwwX.........',
    '.........XwhsssssssssssssssssssssssssswX........',
    '.........XssssssssssssssssssssssssssssssX.......',
    '.........XsssssPPPPPPPssssPPPPPPPssssssX........',
    '.........XsssPPPPPPPPPPssPPPPPPPPPPssssX........',
    '.........XsPPPwwwPPPPPPPPPPPPwwwPPPssssX........',
    '.........XsPPPwXwPPPPPPPPPPPPPPwXwPPPssX........',
    '.........XsPPPwwwPPPPPPPPPPPPPPwwwPPPssX........',
    '.........XssPPPwPPPPPPPPPPPPPPPPwPPPsssX........',
    '.........XssPPPPPPPPPPXXPPPPPPPPPPssssX.........',
    '.........XssPPPPPPPPPXXXXPPPPPPPPPssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '.........XsssPPPPPPPPXppXPPPPPPPPsssssX.........',
    '..........XsssPPPPPPPXXPPPPPPPPPPPssssX.........',
    '..........XssssPPPPPPPPPPPPPPPPPPPsssX..........',
    '...........XXsssssPPPPPPPPPPPPPPPPsssXX.........',
    '............XssssssPPPPPPPPPPPPPPPsssX..........',
    '.............XssssssPPPPPPPPPPPPPPssXX..........',
    '..........XXXXhttttttttttttttttttXXXX...........',
    '.........XhwwtttttttwwwwwwwwtttttttwwwX.........',
    '.........XwwtttttttswwttttttttttzztwwwX.........',
    '.........XwtttttttstttttttttzztttttwwwX.........',
    '........XXXXXXXXXsXXXXXXXXPPPPPPPttwwwX.........',
    '........XhppppppXppppppppXPPPPPPPttwwwX.........',
    '........XpppwwwwpppppppppXPPPPPPPttwwwX.........',
    '........XppppppppppppppppXPPPPPPPttwwwX.........',
    '........XppwwwwwpppppppppXPPPPPPPttwwwX.........',
    '........XppppppppppppppppXPPPPPPPttwwwX.........',
    '........XppppppppppppppppXPPPPPPPttwwwX.........',
    '........XXXXXXXXXXXXXXXXXXPPPPPPPtttX...........',
    '.....XzzzzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzbzzX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '.....XzzzzzzX.XXsssssssXXsssssssXX..............',
    '.....XzzzzzzX..XsssssssXXsssssssX...............',
    '......XXXXX....XsssssssXXsssssssX...............',
    '...............XsssssssXXsssssssX...............',
    '..............XXsssssssXXsssssssXX..............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '.............XwwwwwwwwwXXwwwwwwwwwX.............',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
]


// ---------------------------------------------------------------------------
// Walk sheet (M3): same 48px leg/bob scheme as the teammate walk — derived
// from idle frame 0 via deterministic pixel transforms.
// ---------------------------------------------------------------------------

/**
 * Shift the pixel run at columns [start, start+len) by `dx` within one row,
 * filling vacated cells with '.'. Callers must ensure the target cells are
 * transparent in the original row.
 */
function shiftSpan(row, start, len, dx) {
  const cells = row.split('')
  const span = cells.slice(start, start + len)
  for (let i = start; i < start + len; i += 1) cells[i] = '.'
  for (let i = 0; i < len; i += 1) cells[start + dx + i] = span[i]
  return cells.join('')
}

/** Return a copy of `frame` with rows [start, start+rows.length) replaced. */
function withRows(frame, start, rows) {
  return [...frame.slice(0, start), ...rows, ...frame.slice(start + rows.length)]
}

/**
 * Body bob: the whole body drops 1px while the sole row stays planted (the
 * boot row above the soles is squashed out). Used for the "legs together"
 * walk frames.
 */
function bob(frame, frameWidth) {
  return ['.'.repeat(frameWidth), ...frame.slice(0, -2), frame[frame.length - 1]]
}

/**
 * Generic 48px walk builder for archetypes whose legs/boots share the
 * teammate's geometry (rows 39-47, legs at cols 14-23/24-33): left leg
 * forward / legs together / right leg forward / together, with the two bob
 * frames distinguished by a 1px sway of the given decorative span (post-bob
 * coordinates) — reviewer sways its satchel bottom, coordinator its tail.
 */
function buildWalk48(base, sway) {
  const leftForward = withRows(base, 39, [
    shiftSpan(base[39], 14, 10, -1), // left leg top
    shiftSpan(base[40], 15, 9, -1),  // left leg
    shiftSpan(base[41], 15, 9, -1),
    shiftSpan(base[42], 15, 9, -1),
    shiftSpan(base[43], 14, 10, -1), // left leg bottom
    shiftSpan(base[44], 13, 11, -1), // left boot
    shiftSpan(base[45], 13, 11, -1),
    shiftSpan(base[46], 13, 11, -1),
    shiftSpan(base[47], 14, 9, -1),  // left sole
  ])
  const rightForward = withRows(base, 39, [
    shiftSpan(base[39], 24, 10, 1),  // right leg top
    shiftSpan(base[40], 24, 9, 1),   // right leg
    shiftSpan(base[41], 24, 9, 1),
    shiftSpan(base[42], 24, 9, 1),
    shiftSpan(base[43], 24, 10, 1),  // right leg bottom
    shiftSpan(base[44], 24, 11, 1),  // right boot
    shiftSpan(base[45], 24, 11, 1),
    shiftSpan(base[46], 24, 11, 1),
    shiftSpan(base[47], 25, 9, 1),   // right sole
  ])
  const bobbed = bob(base, 48)
  const swayRight = withRows(bobbed, sway.row, [shiftSpan(bobbed[sway.row], sway.start, sway.len, 1)])
  const swayLeft = withRows(bobbed, sway.row, [shiftSpan(bobbed[sway.row], sway.start, sway.len, -1)])
  return [leftForward, swayRight, rightForward, swayLeft]
}

const REVIEWER_WALK = buildWalk48(REVIEWER_IDLE[0], { row: 42, start: 6, len: 5 }) // satchel bottom sways

export function sheets() {
  return [
  {
    file: 'reviewer.ts',
    exports: [
      ['reviewerIdle', { name: 'reviewer.idle', frameWidth: 48, frameHeight: 48, fps: 6, legend: LEGEND, frames: REVIEWER_IDLE }],
      ['reviewerWork', { name: 'reviewer.work', frameWidth: 48, frameHeight: 48, fps: 6, legend: LEGEND, frames: REVIEWER_WORK }],
      ['reviewerWalk', { name: 'reviewer.walk', frameWidth: 48, frameHeight: 48, fps: 6, legend: LEGEND, frames: REVIEWER_WALK }],
    ],
  },
  ]
}
