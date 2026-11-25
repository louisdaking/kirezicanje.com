// =====================================================
// SMARTSEARCH.JS  (new file)  -  the "brain" of the search
//
// What it understands (Kirundi, Français, English mixed together):
//   "umukobwa bujumbura 20-25"   -> girls, in Burundi, aged 20 to 25
//   "filles kigali"              -> girls in Rwanda
//   "boys under 30 dubai"        -> boys under 30 in the UAE
//   "jan de dieu"  /  "JeanDeDieu" -> finds "Jean de Dieu"   (spaces do not matter)
//   "niyonkuru" / "niyonkuri" / "nionkuru" -> same person    (typos + sounds-alike)
//   "aba kwegereye" / "près de moi" / "near me" -> my own country
//
// It is made of pure functions (no page, no Supabase), so it can be
// tested alone. social.js only calls  smartSearch(...)  and  expandWords(...).
// =====================================================

// lower case, no accents
export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// ---------- how many typos between two words ----------
export function lev(a, b, max = 3) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

// ---------- "sounds like" key: Niyonkuru ~ Niyonkuri ~ Nionkuru ----------
export function phon(word) {
  let w = norm(word).replace(/[^a-z]/g, '')
  if (!w) return ''
  w = w.replace(/ph/g, 'f').replace(/ck|kk|q/g, 'k').replace(/sh|ch|tch/g, 'c').replace(/th/g, 't')
    .replace(/dj/g, 'j').replace(/gh/g, 'g').replace(/ou/g, 'u').replace(/x/g, 'ks')
    .replace(/w/g, 'u').replace(/y/g, 'i').replace(/z/g, 's').replace(/h/g, '')
    .replace(/e/g, 'i').replace(/o/g, 'u')
  return w.replace(/(.)\1+/g, '$1')            // aa -> a, nn -> n
}

// Dice similarity of letter pairs (0..1): good for "nearly the same text"
function dice(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1) } return m }
  const A = grams(a), B = grams(b)
  let hit = 0
  A.forEach((n, g) => { if (B.has(g)) hit += Math.min(n, B.get(g)) })
  return (2 * hit) / (a.length - 1 + b.length - 1)
}

// ---------- word lists ----------
const FEMALE = ['umukobwa', 'abakobwa', 'umugore', 'abagore', 'mukobwa', 'nyampinga', 'girl', 'girls', 'woman', 'women', 'female', 'lady', 'ladies', 'fille', 'filles', 'femme', 'femmes', 'madame', 'mademoiselle', 'dame']
const MALE = ['umuhungu', 'abahungu', 'umugabo', 'abagabo', 'muhungu', 'mugabo', 'boy', 'boys', 'man', 'men', 'male', 'guy', 'guys', 'gentleman', 'garcon', 'garcons', 'homme', 'hommes', 'monsieur']
const NEAR = ['near', 'nearby', 'kwegereye', 'hafi', 'proche', 'pres']      // "near me", "aba kwegereye", "près de moi"
const YOUNG = ['young', 'jeune', 'jeunes', 'abato', 'umutoya', 'youth']
const MATURE = ['mature', 'matures', 'abakuru', 'umukuru', 'age', 'older']
const UNDER = ['under', 'below', 'less', 'younger', 'moins', 'munsi', 'sous', 'max']
const OVER = ['over', 'above', 'older', 'plus', 'hejuru', 'apres', 'min', 'after']
const FILLER = ['de', 'du', 'des', 'la', 'le', 'les', 'ya', 'za', 'wa', 'ba', 'mu', 'in', 'at', 'a', 'au', 'aux', 'et', 'and', 'the', 'moi', 'me', 'ans', 'yrs', 'yr', 'years', 'year', 'imyaka', 'age', 'than', 'to', 'kuri', 'i', 'ku', 'abantu', 'people', 'gens', 'umuntu', 'rondera', 'search', 'find', 'cherche', 'abafite', 'ufite', 'with', 'avec', 'from', 'aba', 'abava', 'ava', 'dhabi', 'salaam', 'es', 'cape', 'town', 'york', 'new']

// where people live: the app saves a COUNTRY in "address". Cities and nicknames point to it.
// key (normalised text found in the saved country)  ->  words that mean it
const PLACES = {
  burundi: ['burundi', 'bdi', 'bujumbura', 'bujumbra', 'bujum', 'bjm', 'buja', 'gitega', 'ngozi', 'muyinga', 'rumonge', 'makamba', 'kayanza', 'bubanza', 'cibitoke', 'rutana', 'ruyigi', 'kirundo', 'cankuzo', 'bururi', 'karuzi', 'mwaro', 'muramvya', 'ubuhundi', 'burundais', 'burundaise'],
  rwanda: ['rwanda', 'kigali', 'huye', 'butare', 'musanze', 'rubavu', 'gisenyi', 'rusizi', 'u-rwanda', 'urwanda', 'rwandais', 'rwandaise'],
  'united arab emirates': ['uae', 'emirates', 'emirats', 'dubai', 'dubay', 'abudhabi', 'sharjah', 'sharja', 'ajman', 'dubayi'],
  'arabie saoudite': ['arabie', 'saudi', 'saoudite', 'riyadh', 'riyad', 'jeddah', 'jedda', 'ksa', 'mecca', 'makka', 'medina', 'dammam'],
  america: ['america', 'usa', 'us', 'amerika', 'ameriki', 'etatsunis', 'states', 'newyork', 'texas', 'california', 'florida', 'boston', 'chicago', 'atlanta', 'washington', 'dallas', 'houston'],
  canada: ['canada', 'kanada', 'montreal', 'toronto', 'ottawa', 'quebec', 'vancouver', 'calgary'],
  kenya: ['kenya', 'nairobi', 'mombasa', 'kisumu', 'nakuru'],
  tanzania: ['tanzania', 'tanzanie', 'dar', 'daresalaam', 'kigoma', 'arusha', 'dodoma', 'mwanza', 'zanzibar'],
  uganda: ['uganda', 'ouganda', 'kampala', 'entebbe', 'jinja', 'gulu'],
  congo: ['congo', 'rdc', 'drc', 'kinshasa', 'goma', 'bukavu', 'uvira', 'lubumbashi', 'kisangani', 'kongo'],
  'south africa': ['southafrica', 'afrique', 'johannesburg', 'joburg', 'capetown', 'durban', 'pretoria', 'sa'],
  nigeria: ['nigeria', 'lagos', 'abuja'],
  france: ['france', 'ubufaransa', 'paris', 'lyon', 'marseille', 'lille', 'toulouse', 'bordeaux', 'nantes', 'faransa', 'francais'],
  belgium: ['belgium', 'belgique', 'ububiligi', 'bruxelles', 'brussels', 'anvers', 'liege', 'gent', 'gand', 'belge'],
  germany: ['germany', 'allemagne', 'ubudage', 'berlin', 'munich', 'hamburg', 'frankfurt', 'deutschland'],
  'united kingdom': ['uk', 'england', 'angleterre', 'london', 'londres', 'manchester', 'britain', 'ubwongereza', 'royaume', 'birmingham'],
  italy: ['italy', 'italie', 'rome', 'milan', 'milano', 'italia'],
  spain: ['spain', 'espagne', 'madrid', 'barcelona', 'barcelone', 'espana'],
  switzerland: ['switzerland', 'suisse', 'geneve', 'geneva', 'zurich', 'lausanne', 'berne'],
  netherlands: ['netherlands', 'holland', 'hollande', 'pays-bas', 'paysbas', 'amsterdam', 'rotterdam'],
  sweden: ['sweden', 'suede', 'stockholm'],
  norway: ['norway', 'norvege', 'oslo'],
  australia: ['australia', 'australie', 'sydney', 'melbourne'],
  china: ['china', 'chine', 'beijing', 'pekin', 'shanghai', 'guangzhou'],
  india: ['india', 'inde', 'delhi', 'mumbai'],
  japan: ['japan', 'japon', 'tokyo', 'osaka'],
  qatar: ['qatar', 'doha'],
  kuwait: ['kuwait', 'koweit'],
  oman: ['oman', 'muscat', 'masqat'],
  bahrain: ['bahrain', 'bahrein', 'manama'],
  egypt: ['egypt', 'egypte', 'cairo', 'caire'],
  morocco: ['morocco', 'maroc', 'casablanca', 'rabat', 'marrakech']
}

// words that mean the same thing (for the posts: "urukundo" also finds "love" and "amour")
const SYNONYMS = [
  ['urukundo', 'love', 'amour', 'amor', 'gukunda', 'kunda', 'heart', 'coeur', 'umutima', 'romance', 'romantique'],
  ['inshuti', 'friend', 'friends', 'ami', 'amie', 'amis', 'copain', 'copine', 'friendship', 'amitie'],
  ['ubukwe', 'wedding', 'mariage', 'marriage', 'marry', 'epouse', 'gushyingirwa', 'bride', 'groom'],
  ['umugore', 'wife', 'femme', 'epouse', 'woman'],
  ['umugabo', 'husband', 'mari', 'epoux', 'man'],
  ['umukobwa', 'girl', 'fille', 'lady'],
  ['umuhungu', 'boy', 'garcon', 'guy'],
  ['ikaze', 'welcome', 'bienvenue', 'karibu'],
  ['murakoze', 'merci', 'thanks', 'thank', 'asante', 'gratitude'],
  ['amahoro', 'peace', 'paix', 'calm'],
  ['umuziki', 'music', 'musique', 'song', 'chanson', 'indirimbo', 'kuririmba', 'sing', 'chanter'],
  ['umupira', 'football', 'soccer', 'foot', 'ballon', 'match'],
  ['gusenga', 'pray', 'prayer', 'priere', 'church', 'eglise', 'kiliziya', 'imana', 'god', 'dieu', 'jesus', 'yezu'],
  ['ibiryo', 'food', 'nourriture', 'cuisine', 'cook', 'cooking', 'kurya', 'repas', 'meal'],
  ['urugendo', 'travel', 'voyage', 'trip', 'vacation', 'vacances', 'holiday', 'journey', 'gutembera'],
  ['ishuri', 'school', 'ecole', 'university', 'universite', 'campus', 'student', 'etudiant', 'umunyeshuri'],
  ['akazi', 'work', 'travail', 'job', 'boulot', 'business', 'umwuga', 'office'],
  ['ubwiza', 'beauty', 'beaute', 'beautiful', 'beau', 'belle', 'nziza', 'pretty', 'handsome', 'gorgeous', 'mwiza'],
  ['urwenya', 'funny', 'drole', 'humour', 'humor', 'joke', 'comedy', 'rire', 'laugh'],
  ['ifoto', 'photo', 'picture', 'image', 'pic', 'selfie', 'portrait'],
  ['isoko', 'market', 'marche', 'shopping', 'boutique'],
  ['inzu', 'house', 'maison', 'home', 'chez', 'villa'],
  ['imodoka', 'car', 'voiture', 'auto', 'drive'],
  ['umunsi', 'day', 'jour', 'birthday', 'anniversaire', 'isabukuru', 'party', 'fete'],
  ['ijoro', 'night', 'nuit', 'soiree', 'evening', 'umugoroba'],
  ['mugitondo', 'morning', 'matin', 'bonjour', 'amakuru', 'hello', 'salut', 'hi', 'mwaramutse', 'bonsoir'],
  ['ubuzima', 'life', 'vie', 'health', 'sante', 'vivre'],
  ['umukino', 'game', 'jeu', 'play', 'jouer', 'gaming', 'sport'],
  ['imyambaro', 'clothes', 'vetements', 'fashion', 'mode', 'style', 'outfit', 'robe', 'dress'],
  ['umudamu', 'dancing', 'dance', 'danse', 'kubyina', 'danser', 'ballet']
]
const SYN_INDEX = new Map()
SYNONYMS.forEach((g, gi) => g.forEach(w => { const k = norm(w); if (!SYN_INDEX.has(k)) SYN_INDEX.set(k, new Set()); SYN_INDEX.get(k).add(gi) }))

// the words (plus their friends) to look for inside post captions
export function expandWords(tokens, limit = 14) {
  const out = new Set()
  tokens.forEach(t => {
    if (t.length < 2) return
    out.add(t)
    const groups = SYN_INDEX.get(t)
    if (groups) groups.forEach(gi => SYNONYMS[gi].forEach(w => out.add(norm(w))))
  })
  return [...out].slice(0, limit)
}

const hasWord = (list, t) => list.includes(t)
const isNum = (t) => /^\d{1,3}$/.test(t)

// ---------- 1. understand the sentence ----------
export function understand(raw, countries) {
  const text = norm(raw).replace(/[“”"']/g, ' ').replace(/[,;:!?()]/g, ' ')
  const intent = { sex: '', ageMin: null, ageMax: null, country: '', near: false }
  const chips = []
  let rest = ' ' + text.replace(/\s+/g, ' ').trim() + ' '

  // age ranges: "20-25", "20 to 25", "entre 20 et 25"
  let m = rest.match(/(?:entre\s+)?\b(\d{2})\s*(?:-|–|to|a|et|and|na|kugeza)\s*(\d{2})\b/)
  if (m && +m[1] >= 16 && +m[2] <= 99 && +m[1] <= +m[2]) {
    intent.ageMin = +m[1]; intent.ageMax = +m[2]
    rest = rest.replace(m[0], ' ')
  }
  // "under 30", "moins de 30", "<30", "munsi ya 30"
  if (intent.ageMin == null) {
    m = rest.match(/(?:\b(?:under|below|less than|less|younger than|moins de|moins|munsi ya|munsi|sous|max)\b|<)\s*(\d{2})\b/)
    if (m && +m[1] >= 16) { intent.ageMax = +m[1] - 1; rest = rest.replace(m[0], ' '); chips.push(['🎂', 'under ' + m[1]]) }
  }
  // "over 25", "plus de 25", ">25", "hejuru ya 25"
  if (intent.ageMin == null && intent.ageMax == null) {
    m = rest.match(/(?:\b(?:over|above|older than|plus de|plus|hejuru ya|hejuru|apres|min)\b|>)\s*(\d{2})\b/)
    if (m && +m[1] >= 16) { intent.ageMin = +m[1] + 1; rest = rest.replace(m[0], ' '); chips.push(['🎂', 'over ' + m[1]]) }
  }
  // "22 ans", "22 yrs", "imyaka 22", "age 22", "22+"
  if (intent.ageMin == null && intent.ageMax == null) {
    m = rest.match(/\b(\d{2})\s*(?:\+)\s/)
    if (m && +m[1] >= 16) { intent.ageMin = +m[1]; rest = rest.replace(m[0], ' ') }
    else {
      m = rest.match(/\b(\d{2})\s*(?:ans|an|yrs|yr|years|year|y\/o|imyaka|ans)\b/) || rest.match(/\b(?:imyaka|age|ageu|aged)\s*(\d{2})\b/)
      if (m && +m[1] >= 16 && +m[1] <= 99) { intent.ageMin = intent.ageMax = +m[1]; rest = rest.replace(m[0], ' ') }
    }
  }

  const words = rest.split(' ').filter(Boolean)
  const name = []
  const placeOf = (w) => {
    for (const key in PLACES) if (PLACES[key].includes(w)) return key
    return ''
  }
  const knownKeys = Object.keys(PLACES)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (hasWord(FEMALE, w)) { intent.sex = intent.sex === 'm' ? '' : 'f'; continue }
    if (hasWord(MALE, w)) { intent.sex = intent.sex === 'f' ? '' : 'm'; continue }
    if (hasWord(NEAR, w)) { intent.near = true; continue }
    if (hasWord(YOUNG, w) && intent.ageMin == null && intent.ageMax == null) { intent.ageMin = 18; intent.ageMax = 25; chips.push(['🌱', 'young']); continue }
    if (hasWord(MATURE, w) && w !== 'age' && intent.ageMin == null && intent.ageMax == null) { intent.ageMin = 30; chips.push(['🎂', '30+']); continue }
    const pk = placeOf(w)
    if (pk && !intent.country) { intent.country = pk; continue }
    // a country typed with a typo ("burundy", "ruanda", "kenia")
    if (!pk && w.length >= 5 && !intent.country) {
      let best = '', bd = 9
      knownKeys.forEach(k => PLACES[k].forEach(a => { if (a.length >= 5) { const d = lev(w, a, 2); if (d < bd) { bd = d; best = k } } }))
      if (best && bd <= (w.length >= 7 ? 2 : 1)) { intent.country = best; continue }
    }
    if (isNum(w)) {
      const n = +w
      if (n >= 18 && n <= 70 && intent.ageMin == null && intent.ageMax == null) { intent.ageMin = intent.ageMax = n; continue }
      continue
    }
    if (hasWord(FILLER, w) || hasWord(UNDER, w) || hasWord(OVER, w)) continue
    name.push(w)
  }
  // two-word cities: "abu dhabi", "dar es salaam", "cape town", "new york"
  const joined = text.replace(/\s+/g, '')
  if (!intent.country) {
    for (const key in PLACES) {
      const alias = PLACES[key].find(a => a.length >= 6 && joined.includes(a))
      if (alias) {
        intent.country = key
        for (let k = name.length - 1; k >= 0; k--) if (name[k].length >= 2 && alias.includes(name[k])) name.splice(k, 1)   // "abu" of "abu dhabi"
        break
      }
    }
  }

  // chips shown to the user: "this is what I understood"
  const shown = []
  if (intent.sex) shown.push([intent.sex === 'f' ? '👩' : '👨', intent.sex === 'f' ? 'umukobwa / umugore' : 'umuhungu / umugabo'])
  if (intent.country) {
    const label = (countries || []).find(c => norm(c).includes(intent.country)) || intent.country
    shown.push(['📍', label])
  }
  if (intent.near) shown.push(['📍', 'hafi yawe'])
  if (intent.ageMin != null || intent.ageMax != null) {
    const a = intent.ageMin, b = intent.ageMax
    shown.push(['🎂', a != null && b != null ? (a === b ? a + ' yrs' : a + '–' + b + ' yrs') : a != null ? a + '+ yrs' : '≤ ' + b + ' yrs'])
  }
  return { intent, name, chips: shown, text }
}

// ---------- 2. score one person for the name words ----------
function nameScore(p, nameWords, extraText) {
  const full = norm(p.full_name)
  const words = full.split(/\s+/).filter(Boolean)
  const wordsPh = words.map(phon)
  const squashed = full.replace(/[^a-z0-9]/g, '')
  const qSquashed = nameWords.join('')
  let total = 0

  // the whole thing typed with no spaces / other order: "jeandedieu"
  if (qSquashed.length >= 4 && squashed) {
    if (squashed === qSquashed) return 140
    if (squashed.startsWith(qSquashed)) total = Math.max(total, 110)
    if (squashed.includes(qSquashed)) total = Math.max(total, 70)
  }

  let matched = 0
  let sum = 0
  for (const t of nameWords) {
    const tp = phon(t)
    let best = 0
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      if (w === t) best = Math.max(best, 100)
      else if (w.startsWith(t)) best = Math.max(best, 85 - Math.min(10, w.length - t.length))
      else if (t.length >= 3 && w.includes(t)) best = Math.max(best, 45)
      else if (t.length >= 3 && t.startsWith(w) && w.length >= 3) best = Math.max(best, 40)   // typed "jeanpierre" word by word
      if (best < 60 && tp.length >= 2) {
        if (wordsPh[i] === tp) best = Math.max(best, 66)
        else if (tp.length >= 3 && wordsPh[i].startsWith(tp)) best = Math.max(best, 55)
      }
      if (best < 50 && t.length >= 3 && w.length >= 3) {
        const d = Math.min(lev(t, w, 2), lev(t, w.slice(0, t.length + 1), 2))
        if (d <= (t.length >= 8 ? 2 : 1) && (t.length >= 4 || w.length >= 4)) best = Math.max(best, 48 - d * 8)   // typo friendly
      }
      if (best < 35 && t.length >= 4 && w.length >= 4) {
        const dc = dice(t, w)
        if (dc >= 0.6) best = Math.max(best, Math.round(20 + dc * 20))             // looks alike
      }
    }
    if (!best && extraText) {                                                       // bio / interests / job
      for (const w of extraText) {
        if (w === t) best = Math.max(best, 22)
        else if (t.length >= 4 && w.startsWith(t)) best = Math.max(best, 14)
      }
    }
    if (best) { matched++; sum += best }
  }
  if (matched === nameWords.length) {
    total = Math.max(total, sum + (nameWords.length > 1 ? 15 : 0))
    if (norm(p.full_name).startsWith(nameWords[0])) total += 8
  } else if (matched > 0 && nameWords.length >= 3 && matched >= nameWords.length - 1) {
    total = Math.max(total, Math.round(sum * 0.6))                                  // one word of a long sentence did not match
  }
  return total
}

const TEXT_KEYS = ['bio', 'about', 'description', 'interests', 'job', 'profession', 'hobby', 'hobbies', 'city', 'town', 'status_text']
function extraWords(p) {
  const out = []
  TEXT_KEYS.forEach(k => { if (p[k] && typeof p[k] === 'string') norm(p[k]).split(/[^a-z0-9]+/).forEach(w => { if (w.length > 2) out.push(w) }) })
  return out
}

export function ageOf(p) {
  if (p.age != null && p.age !== '' && isFinite(+p.age)) return +p.age
  if (p.birth_year && isFinite(+p.birth_year)) return new Date().getFullYear() - +p.birth_year
  return null
}
export function sexGroup(sex) {
  const x = norm(sex).trim()
  if (x === 'umuhungu' || x === 'umugabo') return 'm'
  if (x === 'umukobwa' || x === 'umugore') return 'f'
  return ''
}

// ---------- 3. the whole search ----------
// people: profile rows (already without me and already passed the manual filters)
// ctx: { mine: my country, talked: {id: n}, following: (id)=>bool, countries: [..] }
export function smartSearch(people, raw, ctx = {}) {
  const countries = ctx.countries || [...new Set(people.map(p => p.address).filter(Boolean))]
  const parsed = understand(raw, countries)
  const { intent } = parsed
  const nameWords = parsed.name
  const mine = norm(ctx.mine || '')

  const hardPass = (p, relaxAge) => {
    if (intent.sex && sexGroup(p.sex) !== intent.sex) return false
    if (intent.country && !norm(p.address).includes(intent.country)) return false
    if (intent.near && mine && norm(p.address) !== mine) return false
    if (!relaxAge && (intent.ageMin != null || intent.ageMax != null)) {
      const a = ageOf(p)
      if (a == null) return false
      if (intent.ageMin != null && a < intent.ageMin) return false
      if (intent.ageMax != null && a > intent.ageMax) return false
    }
    return true
  }
  const boost = (p) => {
    let b = 0
    if (ctx.talked && ctx.talked[p.id]) b += 4
    if (ctx.following && ctx.following(p.id)) b += 3
    if (mine && norm(p.address) === mine) b += 2
    if (p.profile_pic) b += 1
    return b
  }
  const rank = (relaxAge) => {
    const out = []
    for (const p of people) {
      if (!hardPass(p, relaxAge)) continue
      let s
      if (nameWords.length) {
        s = nameScore(p, nameWords, extraWords(p))
        if (!s) continue
      } else {
        s = 30                                    // only filters were typed: everybody who fits
      }
      out.push({ p, s: s + boost(p) })
    }
    return out.sort((a, b) => b.s - a.s || String(a.p.full_name).localeCompare(String(b.p.full_name)))
  }

  let list = rank(false)
  let relaxed = ''
  const hasAge = intent.ageMin != null || intent.ageMax != null
  if (!list.length && hasAge) { list = rank(true); if (list.length) relaxed = 'age' }

  // nothing at all? suggest the closest name ("Did you mean ...?")
  let suggestion = ''
  if (!list.length && nameWords.length) {
    const q = nameWords.join(' ')
    let best = 0
    for (const p of people) {
      if (!hardPass(p, true)) continue
      const n = norm(p.full_name)
      const sc = Math.max(dice(q.replace(/\s/g, ''), n.replace(/\s/g, '')), ...n.split(/\s+/).map(w => dice(q, w)))
      if (sc > best) { best = sc; suggestion = p.full_name }
    }
    if (best < 0.34) suggestion = ''
  }

  return { list: list.slice(0, 60), parsed, relaxed, suggestion, tokens: nameWords }
}
