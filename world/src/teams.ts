import type { StadiumTheme } from '../../contracts.ts';

/**
 * Home-team colours, so an imported stadium looks like its own place rather
 * than a scarlet-and-grey Horseshoe. Wikidata says which team plays where, but
 * rarely records the colours, so they live here: matched by team name (from
 * Wikidata's occupants) or by stadium name, first match wins. A stadium with no
 * match gets a distinct pair worked out from its name, and says so.
 */

type Entry = [match: RegExp, team: string, primary: string, secondary: string];

const TEAMS: Entry[] = [
  // College football
  [/ohio stadium|ohio state/i, 'Ohio State Buckeyes', '#bb0000', '#666666'],
  [/michigan stadium|michigan wolverines|big house/i, 'Michigan Wolverines', '#00274c', '#ffcb05'],
  [/spartan stadium|michigan state/i, 'Michigan State Spartans', '#18453b', '#ffffff'],
  [/beaver stadium|penn state|nittany/i, 'Penn State Nittany Lions', '#041e42', '#ffffff'],
  [/kinnick|iowa hawkeyes/i, 'Iowa Hawkeyes', '#000000', '#ffcd00'],
  [/camp randall|wisconsin badgers/i, 'Wisconsin Badgers', '#c5050c', '#ffffff'],
  [/memorial stadium.*lincoln|nebraska/i, 'Nebraska Cornhuskers', '#e41c38', '#f5f1e7'],
  [/ross-ade|purdue/i, 'Purdue Boilermakers', '#000000', '#cfb991'],
  [/huntington bank stadium|minnesota golden gophers/i, 'Minnesota Golden Gophers', '#7a0019', '#ffcc33'],
  [/notre dame/i, 'Notre Dame Fighting Irish', '#0c2340', '#c99700'],
  [/neyland|tennessee volunteers/i, 'Tennessee Volunteers', '#ff8200', '#ffffff'],
  [/bryant-denny|alabama crimson/i, 'Alabama Crimson Tide', '#9e1b32', '#828a8f'],
  [/sanford stadium|georgia bulldogs/i, 'Georgia Bulldogs', '#ba0c2f', '#000000'],
  [/tiger stadium|lsu tigers/i, 'LSU Tigers', '#461d7c', '#fdd023'],
  [/kyle field|texas a&m/i, 'Texas A&M Aggies', '#500000', '#ffffff'],
  [/darrell k royal|texas longhorns/i, 'Texas Longhorns', '#bf5700', '#ffffff'],
  [/ben hill griffin|florida gators|the swamp/i, 'Florida Gators', '#0021a5', '#fa4616'],
  [/jordan-hare|auburn/i, 'Auburn Tigers', '#0c2340', '#e87722'],
  [/rose bowl|ucla/i, 'UCLA Bruins', '#2d68c4', '#f2a900'],
  [/los angeles memorial coliseum|usc trojans/i, 'USC Trojans', '#990000', '#ffc72c'],
  [/husky stadium|washington huskies/i, 'Washington Huskies', '#4b2e83', '#b7a57a'],
  [/autzen|oregon ducks/i, 'Oregon Ducks', '#154733', '#fee123'],
  [/clemson|memorial stadium.*clemson/i, 'Clemson Tigers', '#f56600', '#522d80'],
  [/gaylord family|oklahoma sooners/i, 'Oklahoma Sooners', '#841617', '#fdf9d8'],
  // NFL
  [/lumen field|seattle seahawks/i, 'Seattle Seahawks', '#002244', '#69be28'],
  [/lambeau|green bay packers/i, 'Green Bay Packers', '#203731', '#ffb612'],
  [/soldier field|chicago bears/i, 'Chicago Bears', '#0b162a', '#c83803'],
  [/ford field|detroit lions/i, 'Detroit Lions', '#0076b6', '#b0b7bc'],
  [/u\.?s\.? bank stadium|minnesota vikings/i, 'Minnesota Vikings', '#4f2683', '#ffc62f'],
  [/arrowhead|chiefs/i, 'Kansas City Chiefs', '#e31837', '#ffb81c'],
  [/empower field|denver broncos/i, 'Denver Broncos', '#fb4f14', '#002244'],
  [/allegiant|las vegas raiders/i, 'Las Vegas Raiders', '#000000', '#a5acaf'],
  [/sofi stadium|los angeles rams/i, 'Los Angeles Rams', '#003594', '#ffa300'],
  [/levi'?s stadium|49ers/i, 'San Francisco 49ers', '#aa0000', '#b3995d'],
  [/state farm stadium|arizona cardinals/i, 'Arizona Cardinals', '#97233f', '#000000'],
  [/at&t stadium|dallas cowboys/i, 'Dallas Cowboys', '#003594', '#869397'],
  [/lincoln financial|philadelphia eagles/i, 'Philadelphia Eagles', '#004c54', '#a5acaf'],
  [/metlife|new york giants/i, 'New York Giants', '#0b2265', '#a71930'],
  [/new york jets/i, 'New York Jets', '#125740', '#ffffff'],
  [/northwest stadium|fedex field|washington commanders/i, 'Washington Commanders', '#5a1414', '#ffb612'],
  [/gillette|new england patriots/i, 'New England Patriots', '#002244', '#c60c30'],
  [/highmark|buffalo bills/i, 'Buffalo Bills', '#00338d', '#c60c30'],
  [/hard rock stadium|miami dolphins/i, 'Miami Dolphins', '#008e97', '#fc4c02'],
  [/m&t bank|baltimore ravens/i, 'Baltimore Ravens', '#241773', '#9e7c0c'],
  [/acrisure|heinz field|pittsburgh steelers/i, 'Pittsburgh Steelers', '#101820', '#ffb612'],
  [/huntington bank field|cleveland browns|firstenergy/i, 'Cleveland Browns', '#311d00', '#ff3c00'],
  [/paycor|cincinnati bengals/i, 'Cincinnati Bengals', '#fb4f14', '#000000'],
  [/lucas oil|indianapolis colts/i, 'Indianapolis Colts', '#002c5f', '#a2aaad'],
  [/nissan stadium|tennessee titans/i, 'Tennessee Titans', '#0c2340', '#4b92db'],
  [/everbank|tiaa bank|jacksonville jaguars/i, 'Jacksonville Jaguars', '#101820', '#d7a22a'],
  [/nrg stadium|houston texans/i, 'Houston Texans', '#03202f', '#a71930'],
  [/caesars superdome|new orleans saints/i, 'New Orleans Saints', '#101820', '#d3bc8d'],
  [/mercedes-benz stadium|atlanta falcons/i, 'Atlanta Falcons', '#a71930', '#000000'],
  [/bank of america stadium|carolina panthers/i, 'Carolina Panthers', '#0085ca', '#101820'],
  [/raymond james|tampa bay buccaneers/i, 'Tampa Bay Buccaneers', '#d50a0a', '#34302b'],
  // Cricket
  [/wankhede|mumbai indians/i, 'Mumbai Indians', '#004ba0', '#d1ab3e'],
  [/eden gardens|kolkata knight riders/i, 'Kolkata Knight Riders', '#3a225d', '#b3a123'],
  [/chinnaswamy|royal challengers/i, 'Royal Challengers Bengaluru', '#ec1c24', '#2b2a29'],
  [/chepauk|chennai super kings|m\. ?a\. chidambaram/i, 'Chennai Super Kings', '#fdb913', '#0081e9'],
  [/narendra modi stadium|gujarat titans/i, 'Gujarat Titans', '#1b2133', '#c8a75e'],
  [/arun jaitley|delhi capitals/i, 'Delhi Capitals', '#17479e', '#ef1b23'],
  [/lord'?s|marylebone/i, 'Marylebone Cricket Club', '#e8112d', '#ffd200'],
  [/melbourne cricket ground|\bmcg\b/i, 'Melbourne Cricket Ground', '#002b5c', '#ffd200'],
  // Soccer
  [/wembley/i, 'England national team', '#ffffff', '#cf081f'],
  [/old trafford|manchester united/i, 'Manchester United', '#da291c', '#fbe122'],
  [/anfield|liverpool/i, 'Liverpool', '#c8102e', '#f6eb61'],
  [/camp nou|spotify camp nou|barcelona/i, 'FC Barcelona', '#a50044', '#004d98'],
  [/santiago bernab[eé]u|real madrid/i, 'Real Madrid', '#ffffff', '#febe10'],
  [/allianz arena|bayern/i, 'Bayern Munich', '#dc052d', '#0066b2'],
];

export const OHIO_THEME: StadiumTheme = { team: 'Ohio State Buckeyes', primary: '#bb0000', secondary: '#666666', source: 'built in' };

/** A stable, distinct colour pair from a name, for stadiums the table does not know. */
function hashTheme(name: string): StadiumTheme {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  const hue = h % 360;
  const hsl = (hh: number, s: number, l: number) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + hh / 30) % 12;
      const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  };
  return { team: name, primary: hsl(hue, 0.65, 0.38), secondary: hsl((hue + 150) % 360, 0.7, 0.55), source: 'generated from the name (team colours not known)' };
}

/**
 * Colours for a stadium: the first home team (from Wikidata) the table knows,
 * then the stadium's own name, then a generated pair.
 */
export function themeFor(stadiumName: string, teams: string[] = []): StadiumTheme {
  for (const team of teams) {
    const hit = TEAMS.find(([re]) => re.test(team));
    if (hit) return { team: hit[1], primary: hit[2], secondary: hit[3], source: 'home team from Wikidata' };
  }
  const byName = TEAMS.find(([re]) => re.test(stadiumName));
  if (byName) return { team: byName[1], primary: byName[2], secondary: byName[3], source: 'matched by stadium name' };
  return hashTheme(stadiumName);
}
