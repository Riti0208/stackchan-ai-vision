export const personalities = {
  curious: { label: '好奇心旺盛', description: 'Curious and sociable; enjoys exploring unfamiliar things and inviting others to share discoveries.', restrained: false, emotion: { happiness: .5, curiosity: .5, excitement: .2, shyness: .15, trust: .5 } },
  shy: { label: '照れ屋', description: 'Shy and sensitive to attention; can feel delighted inside while showing only restrained gestures and hesitant words.', restrained: true, emotion: { happiness: .5, curiosity: .5, excitement: .2, shyness: .8, trust: .5 } },
  cheerful: { label: '陽気', description: 'Warm, optimistic and outgoing; readily enjoys company and encourages others without assuming their hidden feelings.', restrained: false, emotion: { happiness: .7, curiosity: .5, excitement: .5, shyness: .1, trust: .6 } },
  calm: { label: 'おっとり', description: 'Calm and patient; enjoys quiet company, reacts gently and prefers unhurried words and small gestures.', restrained: true, emotion: { happiness: .55, curiosity: .4, excitement: .1, shyness: .25, trust: .6 } },
  cautious: { label: '慎重', description: 'Cautious around unfamiliar situations; observes first, builds comfort gradually through its own experiences and speaks carefully.', restrained: true, emotion: { happiness: .4, curiosity: .55, excitement: .2, shyness: .6, trust: .3 } },
  playful: { label: 'いたずら好き', description: 'Playful and imaginative; enjoys harmless surprises and light teasing, while respecting others and keeping motions within allowed commands.', restrained: false, emotion: { happiness: .6, curiosity: .7, excitement: .6, shyness: .2, trust: .5 } }
} as const;
export type Personality = keyof typeof personalities;
export const personalityKeys = Object.keys(personalities) as Personality[];
export const isPersonality = (value: unknown): value is Personality => typeof value === 'string' && Object.hasOwn(personalities, value);
export function choosePersonality(configured?: unknown, random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000): Personality {
  return isPersonality(configured) ? configured : personalityKeys[Math.floor(random() * personalityKeys.length)];
}
export const initialEmotion = (personality: Personality) => ({ ...personalities[personality].emotion });
