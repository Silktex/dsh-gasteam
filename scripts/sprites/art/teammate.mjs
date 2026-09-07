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

// teammate (48x48, fps 6): polecat-INSPIRED worker — muted fur, darkwood mask,
//   brass goggle strap with copper rims, parchment muzzle, tint overalls with
//   surface belly patch, steel wrench in the waistband, oxide boots. Idle:
//   belly breathing + one blink frame. Work: hammering loop (raised/mid/strike/
//   recover) with a darkwood handle, steel head, and a single highlight spark
//   pixel on the strike frame. Walk: left leg forward / legs together / right
//   leg forward / together, body bobbing 1px down on the together frames;
//   goggles and muzzle identical to teammateIdle frame 0.
// teammate state sheets (48x48, fps 6, M3): DERIVED from teammateIdle frame 0
//   via deterministic transforms — blocked adds a swinging bronze pocket-watch
//   (pendulum left/center/right/center) and a tapping toe; error raises both
//   arms (waving) and flashes an oxide alarm above the head (frames 0,2 on);
//   done raises both arms, jumps 1px on frames 1,3, and scatters h/b/r
//   confetti (positions differ per frame, >= 5 pixels per frame).

const LEGEND = {
  '.': null, X: 'ink', w: 'darkWood', m: 'muted', b: 'brass', z: 'bronze',
  c: 'copper', s: 'steel', r: 'oxide', h: 'highlight', p: 'parchment',
  P: 'surface', t: 'copper',
}

// ---------------------------------------------------------------------------
// Authored pixel maps (the art lives here).
// ---------------------------------------------------------------------------

const TEAMMATE_IDLE = [
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhmX....................XmmX..........',
    '.........XmmmmX..................XmmmmX.........',
    '.........XmmmmXXXXXXXXXXXXXXXXXXXXmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XhhbbbbbbbbbbbbbbbbbbbbbbbbbbX.........',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmmmX.........',
    '.........XmmwwwchXXcwwwwwwwwchXXcwwwmmX.........',
    '.........XmmwwwwXXXwwwwwwwwwwXXXwwwwmmX.........',
    '.........XmmwwwcXXXcwwwwwwwwcXXXcwwwmmX.........',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmmmX.........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmmmX.........',
    '.........XmmmmmmmmppppppppppppmmmmmmmmX.........',
    '..........XXmmmmmmpppppXppppppmmmmmmXX..........',
    '...........XmmmmmmmmppXpXpppmmmmmmmmX...........',
    '...........XmmmmmmmmppppppppmmmmmmmmX...........',
    '...........XmmmmmmmmmmmmmmmmmmmmmmmmX...........',
    '..........XXXXhtttttttttttttttttttXXXX..........',
    '.........XhmmmttttttttttttttttttttmmmmX.........',
    '.........XmmmmttttbttttttttttbttttmmmmX.........',
    '.........XmmmmttttttttttttttttttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XppppsttstPPPPPPPPPPtttttppppX.........',
    '.........XpppptssttPPPPPPPPPPtttttppppX.........',
    '.........XpppptssttPPPPPPPPPPtttttppppX.........',
    '..........XXXXtssttPPPPPPPPPPtttttXXXX..........',
    '.......XXXX..XwwwwwwwwzzzzwwwwwwwwX.............',
    '......XwwwwX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '......XwwwwX..XXtttttttXXtttttttXX..............',
    '......XwwwwX...XtttttttXXtttttttX...............',
    '......XmmmmX...XtttttttXXtttttttX...............',
    '......XmmmmX...XtttttttXXtttttttX...............',
    '......XmmmmX..XXtttttttXXtttttttXX..............',
    '.....XmmmmmX.XrrrrrrrrrXXrrrrrrrrrX.............',
    '......XXXXX..XrrrrrrrrrXXrrrrrrrrrX.............',
    '.............XrrrrrrrrrXXrrrrrrrrrX.............',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhmX....................XmmX..........',
    '.........XmmmmX..................XmmmmX.........',
    '.........XmmmmXXXXXXXXXXXXXXXXXXXXmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XhhbbbbbbbbbbbbbbbbbbbbbbbbbbX.........',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmmmX.........',
    '.........XmmwwwchXXcwwwwwwwwchXXcwwwmmX.........',
    '.........XmmwwwwXXXwwwwwwwwwwXXXwwwwmmX.........',
    '.........XmmwwwcXXXcwwwwwwwwcXXXcwwwmmX.........',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmmmX.........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmmmX.........',
    '.........XmmmmmmmmppppppppppppmmmmmmmmX.........',
    '..........XXmmmmmmpppppXppppppmmmmmmXX..........',
    '...........XmmmmmmmmppXpXpppmmmmmmmmX...........',
    '...........XmmmmmmmmppppppppmmmmmmmmX...........',
    '...........XmmmmmmmmmmmmmmmmmmmmmmmmX...........',
    '..........XXXXhtttttttttttttttttttXXXX..........',
    '.........XhmmmttttttttttttttttttttmmmmX.........',
    '.........XmmmmttttbttttttttttbttttmmmmX.........',
    '.........XmmmmttttttttttttttttttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XppppsttstPPPPPPPPPPtttttppppX.........',
    '.........XpppptssttPPPPPPPPPPtttttppppX.........',
    '.........XpppptssttPPPPPPPPPPtttttppppX.........',
    '..........XXXXtssttPPPPPPPPPPtttttXXXX..........',
    '......XwwwwX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '......XwwwwX..XXtttttttXXtttttttXX..............',
    '......XwwwwX...XtttttttXXtttttttX...............',
    '......XmmmmX...XtttttttXXtttttttX...............',
    '......XmmmmX...XtttttttXXtttttttX...............',
    '......XmmmmX..XXtttttttXXtttttttXX..............',
    '.....XmmmmmX.XrrrrrrrrrXXrrrrrrrrrX.............',
    '......XXXXX..XrrrrrrrrrXXrrrrrrrrrX.............',
    '.............XrrrrrrrrrXXrrrrrrrrrX.............',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhmX....................XmmX..........',
    '.........XmmmmX..................XmmmmX.........',
    '.........XmmmmXXXXXXXXXXXXXXXXXXXXmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XhhbbbbbbbbbbbbbbbbbbbbbbbbbbX.........',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmmmX.........',
    '.........XmmwwwcwwwcwwwwwwwwcwwwcwwwmmX.........',
    '.........XmmwwwwXXXwwwwwwwwwwXXXwwwwmmX.........',
    '.........XmmwwwcwwwcwwwwwwwwcwwwcwwwmmX.........',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmmmX.........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmmmX.........',
    '.........XmmmmmmmmppppppppppppmmmmmmmmX.........',
    '..........XXmmmmmmpppppXppppppmmmmmmXX..........',
    '...........XmmmmmmmmppXpXpppmmmmmmmmX...........',
    '...........XmmmmmmmmppppppppmmmmmmmmX...........',
    '...........XmmmmmmmmmmmmmmmmmmmmmmmmX...........',
    '..........XXXXhtttttttttttttttttttXXXX..........',
    '.........XhmmmttttttttttttttttttttmmmmX.........',
    '.........XmmmmttttbttttttttttbttttmmmmX.........',
    '.........XmmmmttttttttttttttttttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XppppsttstPPPPPPPPPPtttttppppX.........',
    '.........XpppptssttPPPPPPPPPPtttttppppX.........',
    '.........XpppptssttPPPPPPPPPPtttttppppX.........',
    '..........XXXXtssttPPPPPPPPPPtttttXXXX..........',
    '.......XXXX..XwwwwwwwwzzzzwwwwwwwwX.............',
    '......XwwwwX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '......XwwwwX..XXtttttttXXtttttttXX..............',
    '......XwwwwX...XtttttttXXtttttttX...............',
    '......XmmmmX...XtttttttXXtttttttX...............',
    '......XmmmmX...XtttttttXXtttttttX...............',
    '......XmmmmX..XXtttttttXXtttttttXX..............',
    '.....XmmmmmX.XrrrrrrrrrXXrrrrrrrrrX.............',
    '......XXXXX..XrrrrrrrrrXXrrrrrrrrrX.............',
    '.............XrrrrrrrrrXXrrrrrrrrrX.............',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhmX....................XmmX..........',
    '.........XmmmmX..................XmmmmX.........',
    '.........XmmmmXXXXXXXXXXXXXXXXXXXXmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XhhbbbbbbbbbbbbbbbbbbbbbbbbbbX.........',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmmmX.........',
    '.........XmmwwwchXXcwwwwwwwwchXXcwwwmmX.........',
    '.........XmmwwwwXXXwwwwwwwwwwXXXwwwwmmX.........',
    '.........XmmwwwcXXXcwwwwwwwwcXXXcwwwmmX.........',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmmmX.........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmmmX.........',
    '.........XmmmmmmmmppppppppppppmmmmmmmmX.........',
    '..........XXmmmmmmpppppXppppppmmmmmmXX..........',
    '...........XmmmmmmmmpXppXpppmmmmmmmmX...........',
    '...........XmmmmmmmmppppppppmmmmmmmmX...........',
    '...........XmmmmmmmmmmmmmmmmmmmmmmmmX...........',
    '..........XXXXhtttttttttttttttttttXXXX..........',
    '.........XhmmmttttttttttttttttttttmmmmX.........',
    '.........XmmmmttttbttttttttttbttttmmmmX.........',
    '.........XmmmmttttttttttttttttttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XppppsttstPPPPPPPPPPtttttppppX.........',
    '.........XpppptssttPPPPPPPPPPtttttppppX.........',
    '.........XpppptssttPPPPPPPPPPtttttppppX.........',
    '..........XXXXtssttPPPPPPPPPPtttttXXXX..........',
    '......XwwwwX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '......XwwwwX..XXtttttttXXtttttttXX..............',
    '......XwwwwX...XtttttttXXtttttttX...............',
    '......XmmmmX...XtttttttXXtttttttX...............',
    '......XmmmmX...XtttttttXXtttttttX...............',
    '......XmmmmX..XXtttttttXXtttttttXX..............',
    '.....XmmmmmX.XrrrrrrrrrXXrrrrrrrrrX.............',
    '......XXXXX..XrrrrrrrrrXXrrrrrrrrrX.............',
    '.............XrrrrrrrrrXXrrrrrrrrrX.............',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
]

const TEAMMATE_WORK = [
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhmX....................XmmX..........',
    '.........XmmmmX..................XmmmmXXXXXXX...',
    '.........XmmmmXXXXXXXXXXXXXXXXXXXXmhsssssssssX..',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmssssssssssX..',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmssssssssssX..',
    '.........XhhbbbbbbbbbbbbbbbbbbbbbbbbwwwXXXXXX...',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmwwwX........',
    '.........XmmwwwchXXcwwwwwwwwchXXcwwwwwwX........',
    '.........XmmwwwwXXXwwwwwwwwwwXXXwwwwwwwX........',
    '.........XmmwwwcXXXcwwwwwwwwcXXXcwwwwwwX........',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmwwwX........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmwwwX........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmppwwwX........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmppppX.........',
    '.........XmmmmmmmmppppppppppppmmmmppppX.........',
    '..........XXmmmmmmpppppXppppppmmmmmmmmX.........',
    '...........XmmmmmmmmppXpXpppmmmmmmmmmmX.........',
    '...........XmmmmmmmmppppppppmmmmmmmmmmX.........',
    '...........XmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '..........XXXXhttttttttttttttttttmmmmmX.........',
    '.........XhmmmttttttttttttttttttttXXXX..........',
    '.........XmmmmttttbttttttttttbttttX.............',
    '.........XmmmmttttttttttttttttttttX.............',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XppppsttstPPPPPPPPPPtttttX.............',
    '.........XpppptssttPPPPPPPPPPtttttX.............',
    '.........XpppptssttPPPPPPPPPPtttttX.............',
    '..........XXXXtssttPPPPPPPPPPtttttX.............',
    '.......XXXX..XwwwwwwwwzzzzwwwwwwwwX.............',
    '......XwwwwX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '......XwwwwX..XXtttttttXXtttttttXX..............',
    '......XwwwwX...XtttttttXXtttttttX...............',
    '......XmmmmX...XtttttttXXtttttttX.......XXXXXX..',
    '......XmmmmX...XtttttttXXtttttttX......XhsssssX.',
    '......XmmmmX..XXtttttttXXtttttttXX.....XssssssX.',
    '.....XmmmmmX.XrrrrrrrrrXXrrrrrrrrrX....XssssssX.',
    '......XXXXX..XrrrrrrrrrXXrrrrrrrrrX....XssssssX.',
    '.............XrrrrrrrrrXXrrrrrrrrrX.....XXXXXX..',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhmX....................XmmX..........',
    '.........XmmmmX..................XmmmmX.........',
    '.........XmmmmXXXXXXXXXXXXXXXXXXXXmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XhhbbbbbbbbbbbbbbbbbbbbbbbbbbX.........',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmmmX.........',
    '.........XmmwwwchXXcwwwwwwwwchXXcwwwmmX.........',
    '.........XmmwwwwXXXwwwwwwwwwwXXXwwwwmmX.........',
    '.........XmmwwwcXXXcwwwwwwwwcXXXcwwwmmX.........',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmXXXXXXXX..',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmmmhsssssssX.',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmmmssssssssX.',
    '.........XmmmmmmmmppppppppppppmmmmmmmmssssssssX.',
    '..........XXmmmmmmpppppXppppppmmmmmmXXXwwwXXXX..',
    '...........XmmmmmmmmppXpXpppmmmmmmmmX.XwwwX.....',
    '...........XmmmmmmmmppppppppmmmmmmmmX.XwwwX.....',
    '...........XmmmmmmmmmmmmmmmmmmmmmmmmXXXwwwX.....',
    '..........XXXXhtttttttttttttttttttmmmmpwwwX.....',
    '.........XhmmmttttttttttttttttttttmmmmppppX.....',
    '.........XmmmmttttbttttttttttbttttmmmmppppX.....',
    '.........XmmmmttttttttttttttttttttmmmmppppX.....',
    '.........XmmmmtttttPPPPPPPPPPtttttXXXXXXXX......',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XppppsttstPPPPPPPPPPtttttX.............',
    '.........XpppptssttPPPPPPPPPPtttttX.............',
    '.........XpppptssttPPPPPPPPPPtttttX.............',
    '..........XXXXtssttPPPPPPPPPPtttttX.............',
    '.......XXXX..XwwwwwwwwzzzzwwwwwwwwX.............',
    '......XwwwwX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '......XwwwwX..XXtttttttXXtttttttXX..............',
    '......XwwwwX...XtttttttXXtttttttX...............',
    '......XmmmmX...XtttttttXXtttttttX.......XXXXXX..',
    '......XmmmmX...XtttttttXXtttttttX......XhsssssX.',
    '......XmmmmX..XXtttttttXXtttttttXX.....XssssssX.',
    '.....XmmmmmX.XrrrrrrrrrXXrrrrrrrrrX....XssssssX.',
    '......XXXXX..XrrrrrrrrrXXrrrrrrrrrX....XssssssX.',
    '.............XrrrrrrrrrXXrrrrrrrrrX.....XXXXXX..',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhmX....................XmmX..........',
    '.........XmmmmX..................XmmmmX.........',
    '.........XmmmmXXXXXXXXXXXXXXXXXXXXmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XhhbbbbbbbbbbbbbbbbbbbbbbbbbbX.........',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmmmX.........',
    '.........XmmwwwchXXcwwwwwwwwchXXcwwwmmX.........',
    '.........XmmwwwwXXXwwwwwwwwwwXXXwwwwmmX.........',
    '.........XmmwwwcXXXcwwwwwwwwcXXXcwwwmmX.........',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmmmX.........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmmmX.........',
    '.........XmmmmmmmmppppppppppppmmmmmmmmX.........',
    '..........XXmmmmmmpppppXppppppmmmmmmXX..........',
    '...........XmmmmmmmmppXpXpppmmmmmmmmX...........',
    '...........XmmmmmmmmppppppppmmmmmmmmX...........',
    '...........XmmmmmmmmmmmmmmmmmmmmmmmmX...........',
    '..........XXXXhtttttttttttttttttttXX............',
    '.........XhmmmttttttttttttttttttttXXXX..........',
    '.........XmmmmttttbttttttttttbttttmmmmX.........',
    '.........XmmmmttttttttttttttttttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XmmmmtttttPPPPPPPPPPtttttmmmmX.........',
    '.........XppppsttstPPPPPPPPPPtttttmmmmXX........',
    '.........XpppptssttPPPPPPPPPPtttttXppwwwX.......',
    '.........XpppptssttPPPPPPPPPPtttttXppwwwX.......',
    '..........XXXXtssttPPPPPPPPPPtttttXppwwwX.......',
    '.......XXXX..XwwwwwwwwzzzzwwwwwwwwXXXwwwX.......',
    '......XwwwwX.XwwwwwwwwzzzzwwwwwwwwX.XwwwX.......',
    '......XwwwwX..XXtttttttXXtttttttXX..XwwwXXXXXX..',
    '......XwwwwX...XtttttttXXtttttttX..XssssssssshX.',
    '......XmmmmX...XtttttttXXtttttttX..XsssssssssX..',
    '......XmmmmX...XtttttttXXtttttttX...XXXXhsssssX.',
    '......XmmmmX..XXtttttttXXtttttttXX.....XssssssX.',
    '.....XmmmmmX.XrrrrrrrrrXXrrrrrrrrrX....XssssssX.',
    '......XXXXX..XrrrrrrrrrXXrrrrrrrrrX....XssssssX.',
    '.............XrrrrrrrrrXXrrrrrrrrrX.....XXXXXX..',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
  [
    '................................................',
    '................................................',
    '................................................',
    '................................................',
    '...........XX......................XX...........',
    '..........XhmX....................XmmX..........',
    '.........XmmmmX..................XmmmmX.........',
    '.........XmmmmXXXXXXXXXXXXXXXXXXXXmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '.........XhhbbbbbbbbbbbbbbbbbbbbbbbbbbXXXXXX....',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmhssssssssX...',
    '.........XmmwwwchXXcwwwwwwwwchXXcwwsssssssssX...',
    '.........XmmwwwwXXXwwwwwwwwwwXXXwwwsssssssssX...',
    '.........XmmwwwcXXXcwwwwwwwwcXXXcwwwwwwXXXXX....',
    '.........XmmmmmmcccmmmmmmmmmmcccmmmmwwwX........',
    '.........XmmmmmmmmmmmmmmmmmmmmmmmmmmwwwX........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmwwwX........',
    '.........XmmmmmmmmpppXXXXXXpppmmmmmmwwwX........',
    '.........XmmmmmmmmppppppppppppmmmmmmwwwX........',
    '..........XXmmmmmmpppppXppppppmmmmppwwwX........',
    '...........XmmmmmmmmppXpXpppmmmmmmppppX.........',
    '...........XmmmmmmmmppppppppmmmmmmppppX.........',
    '...........XmmmmmmmmmmmmmmmmmmmmmmmmmmX.........',
    '..........XXXXhttttttttttttttttttmmmmmX.........',
    '.........XhmmmtttttttttttttttttttmmmmmX.........',
    '.........XmmmmttttbttttttttttbttttXXXX..........',
    '.........XmmmmttttttttttttttttttttX.............',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XmmmmtttttPPPPPPPPPPtttttX.............',
    '.........XppppsttstPPPPPPPPPPtttttX.............',
    '.........XpppptssttPPPPPPPPPPtttttX.............',
    '.........XpppptssttPPPPPPPPPPtttttX.............',
    '..........XXXXtssttPPPPPPPPPPtttttX.............',
    '.......XXXX..XwwwwwwwwzzzzwwwwwwwwX.............',
    '......XwwwwX.XwwwwwwwwzzzzwwwwwwwwX.............',
    '......XwwwwX..XXtttttttXXtttttttXX..............',
    '......XwwwwX...XtttttttXXtttttttX...............',
    '......XmmmmX...XtttttttXXtttttttX.......XXXXXX..',
    '......XmmmmX...XtttttttXXtttttttX......XhsssssX.',
    '......XmmmmX..XXtttttttXXtttttttXX.....XssssssX.',
    '.....XmmmmmX.XrrrrrrrrrXXrrrrrrrrrX....XssssssX.',
    '......XXXXX..XrrrrrrrrrXXrrrrrrrrrX....XssssssX.',
    '.............XrrrrrrrrrXXrrrrrrrrrX.....XXXXXX..',
    '..............XXXXXXXXX..XXXXXXXXX..............',
  ],
]


// ---------------------------------------------------------------------------
// Walk sheet (M2): derived from idle frame 0 via deterministic pixel
// transforms — the walk art keeps the idle head/torso and re-poses the legs.
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
 * teammateWalk (48x48, 4f @6fps): left leg forward / legs together / right
 * leg forward / together. Leg alternation shifts the forward leg+boot 1px
 * outward; the together frames bob the body 1px down. Frame 3 additionally
 * swings the visible paw 1px right so the two bob frames stay distinct.
 * Head rows 0..23 of the unbobbed frames are byte-identical to teammateIdle
 * frame 0 (goggles/muzzle unchanged).
 */
function buildTeammateWalk(base) {
  const leftForward = withRows(base, 39, [
    shiftSpan(base[39], 14, 10, -1), // 'XXtttttttX' left leg top
    shiftSpan(base[40], 15, 9, -1),  // 'XtttttttX' left leg
    shiftSpan(base[41], 15, 9, -1),
    shiftSpan(base[42], 15, 9, -1),
    shiftSpan(base[43], 14, 10, -1), // left leg bottom
    shiftSpan(base[44], 13, 11, -1), // 'XrrrrrrrrrX' left boot
    shiftSpan(base[45], 13, 11, -1),
    shiftSpan(base[46], 13, 11, -1),
    shiftSpan(base[47], 14, 9, -1),  // left sole
  ])
  const rightForward = withRows(base, 39, [
    shiftSpan(base[39], 24, 10, 1),  // 'XtttttttXX' right leg top
    shiftSpan(base[40], 24, 9, 1),   // 'XtttttttX' right leg
    shiftSpan(base[41], 24, 9, 1),
    shiftSpan(base[42], 24, 9, 1),
    shiftSpan(base[43], 24, 10, 1),  // right leg bottom
    shiftSpan(base[44], 24, 11, 1),  // 'XrrrrrrrrrX' right boot
    shiftSpan(base[45], 24, 11, 1),
    shiftSpan(base[46], 24, 11, 1),
    shiftSpan(base[47], 25, 9, 1),   // right sole
  ])
  const bobbed = bob(base, 48)
  const bobbedSwing = withRows(bobbed, 42, [
    shiftSpan(bobbed[42], 6, 6, 1),  // 'XmmmmX' paw swings 1px right
    shiftSpan(bobbed[43], 6, 6, 1),
    shiftSpan(bobbed[44], 6, 6, 1),
  ])
  return [leftForward, bobbed, rightForward, bobbedSwing]
}

const TEAMMATE_WALK = buildTeammateWalk(TEAMMATE_IDLE[0])

// ---------------------------------------------------------------------------
// M3 state sheets: deterministic transforms of the idle frame 0 plus small
// stamped additions.
// ---------------------------------------------------------------------------

/**
 * Overlay a small pixel map onto a copy of `frame` at (top, left); '.' cells
 * in the patch leave the base pixel untouched.
 */
function stamp(frame, top, left, rows) {
  const out = frame.slice()
  rows.forEach((patch, dy) => {
    const cells = out[top + dy].split('')
    for (let dx = 0; dx < patch.length; dx += 1) {
      if (patch[dx] !== '.') cells[left + dx] = patch[dx]
    }
    out[top + dy] = cells.join('')
  })
  return out
}

/** Raised-arm stamp maps shared by teammateError and teammateDone. */
const ARM_UP_L = ['XppX', 'XmmX', 'XmmX', 'XmmX', 'XmmX', 'XXXX'] // anchored (20,5)
const ARM_UP_R = ['XppX', 'XmmX', 'XmmX', 'XmmX', 'XmmX', 'XXXX'] // anchored (20,39)
const ARM_OUT_L = ['XppX.', 'XmmX.', 'XmmX.', 'XmmX.', 'XmmX.', '.XmXX', '..XXX'] // anchored (19,4)
const ARM_OUT_R = ['.XppX', '.XmmX', '.XmmX', '.XmmX', '.XmmX', 'XXmX.', 'XXX..'] // anchored (19,39)

/** Base for the raised-arm state sheets: resting paws fold into the torso. */
function raisedArmsBase(base) {
  let out = base
  for (const row of [33, 34, 35]) {
    out = stamp(out, row, 10, ['tttt'])
    out = stamp(out, row, 34, ['tttt'])
  }
  return out
}

/**
 * teammateBlocked (48x48, 4f @6fps): waiting pose (idle body) + a bronze
 * pocket-watch swinging on a chain below the right paw — pendulum
 * left/center/right/center — while the left toe taps (ground/up/ground/mid).
 */
function buildTeammateBlocked(base) {
  const WATCH = ['.XXX.', 'XzzzX', 'XzhzX', 'XzzzX', '.XXX.']
  const frame = (watchLeft, chainTop, chainBottom, toe) => {
    let out = stamp(base, 37, chainTop, ['z'])
    out = stamp(out, 38, chainBottom, ['z'])
    out = stamp(out, 39, watchLeft, WATCH)
    return toe === null ? out : stamp(out, toe[0], toe[1], [toe[2]])
  }
  return [
    frame(30, 36, 35, [47, 13, 'X']), // watch left, toe taps the ground
    frame(34, 36, 36, [44, 12, 'r']), // watch center, toe flicks up
    frame(38, 36, 37, [47, 13, 'X']), // watch right, toe taps the ground
    frame(34, 36, 36, [46, 12, 'r']), // watch center, toe mid-tap
  ]
}

/**
 * teammateError (48x48, 4f @6fps): both arms raised and waving (up on even
 * frames, angled out on odd frames; frame 3 adds a paw flick so frames 1/3
 * stay distinct) + an oxide alarm flashing above the head (frames 0,2 on —
 * frame 2 pulses a highlight pixel — 1,3 off).
 */
function buildTeammateError(base) {
  const ALARM = ['..XX..', '.XrrX.', 'XrrrrX'] // anchored (1,21)
  const ALARM_HI = ['..XX..', '.XrhX.', 'XrrrrX']
  const body = raisedArmsBase(base)
  const frames = []
  for (let index = 0; index < 4; index += 1) {
    let out = index % 2 === 0
      ? stamp(stamp(body, 20, 5, ARM_UP_L), 20, 39, ARM_UP_R)
      : stamp(stamp(body, 19, 4, ARM_OUT_L), 19, 39, ARM_OUT_R)
    if (index === 0) out = stamp(out, 1, 21, ALARM)
    if (index === 2) out = stamp(out, 1, 21, ALARM_HI)
    if (index === 3) out = stamp(stamp(out, 18, 5, ['p']), 18, 42, ['p'])
    frames.push(out)
  }
  return frames
}

/**
 * teammateDone (48x48, 4f @6fps): celebration — both arms up, the body jumps
 * 1px on frames 1,3, and h/b/r confetti pixels hang in the air (6 per frame,
 * positions differ per frame).
 */
function buildTeammateDone(base) {
  const CONFETTI = [
    [[0, 10, 'h'], [1, 15, 'b'], [0, 30, 'r'], [2, 35, 'h'], [1, 25, 'b'], [3, 6, 'r']],
    [[0, 12, 'r'], [2, 17, 'h'], [1, 32, 'b'], [3, 36, 'r'], [0, 26, 'h'], [2, 8, 'b']],
    [[1, 9, 'b'], [0, 18, 'r'], [2, 28, 'h'], [1, 34, 'r'], [3, 24, 'b'], [0, 38, 'h']],
    [[2, 11, 'r'], [0, 14, 'h'], [1, 29, 'b'], [3, 33, 'h'], [2, 22, 'r'], [1, 5, 'b']],
  ]
  const jump = frame => [...frame.slice(1), '.'.repeat(48)]
  const body = stamp(stamp(raisedArmsBase(base), 20, 5, ARM_UP_L), 20, 39, ARM_UP_R)
  return CONFETTI.map((pixels, index) => {
    let out = index % 2 === 1 ? jump(body) : body
    for (const [row, col, char] of pixels) out = stamp(out, row, col, [char])
    return out
  })
}

const TEAMMATE_BLOCKED = buildTeammateBlocked(TEAMMATE_IDLE[0])
const TEAMMATE_ERROR = buildTeammateError(TEAMMATE_IDLE[0])
const TEAMMATE_DONE = buildTeammateDone(TEAMMATE_IDLE[0])

export function sheets() {
  return [
  {
    file: 'teammate.ts',
    exports: [
      ['teammateIdle', { name: 'teammate.idle', frameWidth: 48, frameHeight: 48, fps: 6, legend: LEGEND, frames: TEAMMATE_IDLE }],
      ['teammateWork', { name: 'teammate.work', frameWidth: 48, frameHeight: 48, fps: 6, legend: LEGEND, frames: TEAMMATE_WORK }],
      ['teammateWalk', { name: 'teammate.walk', frameWidth: 48, frameHeight: 48, fps: 6, legend: LEGEND, frames: TEAMMATE_WALK }],
      ['teammateBlocked', { name: 'teammate.blocked', frameWidth: 48, frameHeight: 48, fps: 6, legend: LEGEND, frames: TEAMMATE_BLOCKED }],
      ['teammateError', { name: 'teammate.error', frameWidth: 48, frameHeight: 48, fps: 6, legend: LEGEND, frames: TEAMMATE_ERROR }],
      ['teammateDone', { name: 'teammate.done', frameWidth: 48, frameHeight: 48, fps: 6, legend: LEGEND, frames: TEAMMATE_DONE }],
    ],
  },
  ]
}
