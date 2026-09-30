// 두 확장에서 동일하게 사용하는 로컬 감지기. API나 프롬프트를 호출하지 않는다.
// 신체 단어 하나가 아니라 가까운 행동 표현과 함께 있을 때 강한 신호로 센다.
const EN_BODY = String.raw`\b(?:breasts?|nipples?|clit(?:oris)?|pussy|cock|dick|penis|vulva|vagina|genitals?|outer\s+lips|bundle\s+of\s+nerves)\b`;
const EN_ORAL = String.raw`\b(?:lick(?:s|ed|ing)?|suck(?:s|ed|ing)?|lap(?:s|ped|ping)?|suction)\b`;
const EN_ORAL_MOTION = /\b(?:swirl(?:s|ed|ing)?|press(?:es|ed|ing)?|drag(?:s|ged|ging)?|circl(?:e|es|ed|ing)|flick(?:s|ed|ing)?|lick(?:s|ed|ing)?|suck(?:s|ed|ing)?|lap(?:s|ped|ping)?)\b/i;
const EN_HAND = String.raw`\b(?:finger(?:s|ed|ing)?|digits?|hand)\b`;
const EN_INTIMATE = String.raw`\b(?:wetness|pussy|vagina|canal|clit(?:oris)?|nipples?|genitals?)\b`;
const EN_MOTION = /\b(?:sink(?:s|ing)?|sank|buried|insert(?:s|ed|ing)?|pump(?:s|ed|ing)?|stretch(?:es|ed|ing)?|rub(?:s|bed|bing)?|strok(?:e|es|ed|ing)|penetrat(?:e|es|ed|ing)|fuck(?:s|ed|ing)?)\b/i;
const KO_BODY = String.raw`(?:가슴|유두|젖꼭지|성기|클리토리스|음핵|음순|보지|자지|애액|젖은\s*(?:구멍|속살))`;
const KO_TOUCH = String.raw`(?:핥|빨|애무|주무|움켜|문지|쑤셔|쑤시|쑤셔대|비벼|비비|삽입|밀어\s*넣|박아\s*넣|잠겨|파묻|마디.{0,20}잠)`;
const NEAR = String.raw`[^.!?。！？\n]{0,180}?`;
function nearby(left, right, span = NEAR) {
    return new RegExp(`(?:${left})${span}(?:${right})|(?:${right})${span}(?:${left})`, 'gi');
}

const RULES = [
    { label: '현재 명시적 행위', w: 4, re: /삽입(?:하|했|해|되|된|되는|중)|박아\s*넣|쑤셔\s*넣|사정(?:하|했|해|시키|하며|하는|하려)|오르가즘(?:에|을)\s*(?:도달|느끼)|질\s*(?:안|속)에\s*(?:넣|박)|\bpenetrat(?:e|es|ed|ing)\b|\bthrust(?:ed|ing|s)?\s+(?:inside|into|against)\b|\borgasm(?:s|ed|ing)\b|\bejaculat(?:e|es|ed|ing)\b|\bcame\s+(?:inside|over|on)\b|\bcoming\s+(?:inside|in\s+her|in\s+him)\b/gi },
    { label: '영어 구강 접촉', w: 4, re: nearby(EN_BODY, EN_ORAL) },
    { label: '영어 입·혀 접촉', w: 4, re: nearby(EN_BODY, String.raw`\b(?:tongue|mouth)\b`), require: EN_ORAL_MOTION },
    { label: '영어 직접 행동', w: 4, re: nearby(EN_BODY, String.raw`\b(?:fuck(?:s|ed|ing)?|thrust(?:s|ed|ing)?|insert(?:s|ed|ing)?)\b`) },
    { label: '영어 손 접촉', w: 4, re: nearby(EN_HAND, EN_INTIMATE), require: EN_MOTION },
    { label: '한국어 직접 접촉', w: 4, re: nearby(KO_BODY, KO_TOUCH, String.raw`[^.!?。！？\n]{0,80}?`) },
    { label: '신음 표기', w: 3, re: /하앙|흐응|아앙|흐읏|하아앙|응아|앗\s*…?\s*안|\bmoan(?:ed|ing|s)?\b|\bwhimper(?:ed|ing)?\b/gi },
    { label: '현재 탈의·밀착', w: 2, re: /(?:옷|속옷|팬티|브래지어|바지|치마)(?:을|를)?\s*(?:벗기|벗겨|내리)|\bgrind(?:s|ing)?\s+(?:against|on|into)\b|\bground\s+(?:against|on|into)\b|\bstraddl(?:e|es|ed|ing)\s+(?:her|him|them)\b/gi },
    { label: '성적 접촉 분위기', w: 1, re: /키스가\s*깊어|혀가\s*얽|목덜미에\s*입|귓불을\s*(?:물|빨|핥)|\bkiss(?:es|ed|ing)?\s+(?:deeply|hungrily)\b|\btongues?\s+(?:tangled|met)\b|\bhands?\s+(?:slid|moved)\s+(?:under|between)\b/gi },
];

export function scoreScene(text, customKeywords = '') {
    const source = String(text ?? '')
        .replace(/<(scene_state|sfw_scene)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<(?:scene_state|sfw_scene)\b[^>]*>[\s\S]*$/gi, '');
    const hits = [];
    let score = 0;
    for (const { label, re, w, require } of RULES) {
        re.lastIndex = 0;
        let match;
        let count = 0;
        while (count < 3 && (match = re.exec(source)) !== null) {
            // 동사가 신체/도구보다 먼저 나오는 어순도 같은 문장 안에서 확인한다.
            if (require) {
                const before = source.slice(Math.max(0, match.index - 180), match.index).match(/[^.!?。！？\n]*$/)[0];
                const after = source.slice(re.lastIndex, re.lastIndex + 180).match(/^[^.!?。！？\n]*/)[0];
                if (!require.test(before + match[0] + after)) continue;
            }
            hits.push({ label, text: match[0], w });
            score += w;
            count++;
        }
    }
    const lower = source.toLocaleLowerCase();
    for (const keyword of String(customKeywords).split(',').map((word) => word.trim()).filter(Boolean)) {
        if (lower.includes(keyword.toLocaleLowerCase())) {
            score += 3;
            hits.push({ label: '커스텀', text: keyword, w: 3 });
        }
    }
    return { score, hits };
}
