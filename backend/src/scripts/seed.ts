/**
 * Seed: ensure the custom objects required by the funnel (and all of their
 * custom fields) exist in Twenty. Fully idempotent — safe to re-run:
 * anything already present is skipped.
 *
 * Run with: bun run --cwd backend seed
 *
 * NOTE on Twenty APIs: custom OBJECTS are created via the Metadata API
 * (GraphQL `createOneObject`), while RECORDS are created via the REST API
 * (`POST /rest/agencyOffers`). See README "Creating objects with Twenty".
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../../.env.local') });

const baseUrl = process.env.TWENTY_BASE_URL?.replace(/\/$/, '') || '';
const apiKey = process.env.TWENTY_API_KEY || '';

if (!baseUrl || !apiKey) {
  console.error('TWENTY_BASE_URL and TWENTY_API_KEY required');
  process.exit(1);
}

const metadataUrl = baseUrl.replace(/\/rest$/, '') + '/metadata';

async function gql(query: string, variables: any) {
  const res = await fetch(metadataUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json();
  if (!res.ok || json.errors?.length) {
    console.error('METADATA ERRORS', JSON.stringify(json, null, 2));
    throw new Error(JSON.stringify(json.errors) ?? `metadata ${res.status}`);
  }
  return json.data;
}

async function listObjects() {
  const data: any = await gql(
    `query { objects(paging:{first:100}){ edges{ node{ id nameSingular namePlural fieldsList{ id name type label options } } } } }`,
    {},
  );
  return data.objects.edges.map((e: any) => e.node);
}

// Every custom field this app needs on agencyOffers. SELECT option values
// MUST be UPPER_CASE — Twenty rejects anything else.
const CUSTOM_FIELDS = [
  { name: 'title', label: 'Title', type: 'TEXT', description: 'Funnel title shown in the offer list' },
  { name: 'heroH1', label: 'Hero H1', type: 'TEXT', description: 'Hero heading HTML rendered by the funnel' },
  { name: 'heroLede', label: 'Hero Lede', type: 'RICH_TEXT', description: 'Hero supporting copy rendered by the funnel' },
  { name: 'videoUrl', label: 'Video URL', type: 'LINKS', description: 'Primary and secondary funnel video links' },
  {
    name: 'videoMode', label: 'Video Mode', type: 'SELECT', description: 'Use the prospect video or an offer-wide override',
    options: [
      { label: 'Prospect', value: 'PROSPECT', color: 'blue', position: 0 },
      { label: 'Custom', value: 'CUSTOM', color: 'green', position: 1 },
    ],
  },
  {
    name: 'industryId', label: 'Industry ID', type: 'SELECT', description: 'Industry served by this offer',
    options: [
      { label: 'Auto Paint and Body Shops', value: 'AUTO_PAINT_AND_BODY_SHOPS', color: 'blue', position: 0 },
      { label: 'Window Tinting', value: 'WINDOW_TINTING', color: 'purple', position: 1 },
      { label: 'Auto Detailing', value: 'AUTO_DETAILING', color: 'green', position: 2 },
      { label: 'General Trades', value: 'GENERAL_TRADES', color: 'orange', position: 3 },
    ],
  },
  { name: 'quizConfig', label: 'Quiz Config', type: 'RAW_JSON', description: 'Quiz steps JSON for offer funnel - fed into Quiz.tsx' },
  { name: 'thankYouConfig', label: 'Thank You Config', type: 'RAW_JSON', description: 'Thank-you page blocks JSON' },
  { name: 'disqualifiedConfig', label: 'Disqualified Config', type: 'RAW_JSON', description: 'Disqualified page blocks JSON' },
  { name: 'utmSwaps', label: 'UTM Swaps', type: 'RAW_JSON', description: 'Per-UTM text swaps Record' },
  { name: 'mediaLogos', label: 'Media Logos', type: 'RAW_JSON', description: 'Worked-with logo carousel: [{src, alt}] SVG/IMG URLs rendered navy under the quiz' },
  { name: 'carouselHeading', label: 'Carousel Heading', type: 'TEXT', description: 'Logo carousel H1 HTML (RichEditor). Falls back to default when blank.' },
  { name: 'carouselDesc', label: 'Carousel Description', type: 'RICH_TEXT', description: 'Logo carousel description markdown (RichEditor, {{area}} supported), rendered under the marquee.' },
  { name: 'brandName', label: 'Brand Name', type: 'TEXT', description: 'Brand header name rendered above the hero H1 (e.g. ListeningKit).' },
  { name: 'brandSub', label: 'Brand Subheading', type: 'TEXT', description: 'Six-word service line under the brand name, dynamically per offer.' },
  { name: 'brandLogoUrl', label: 'Brand Logo URL', type: 'TEXT', description: 'Brand mark image URL rendered left of the brand name above the hero H1.' },
  { name: 'calendlyUrl', label: 'Calendly URL', type: 'TEXT', description: 'Calendly link shown in iframe at end of quiz' },
  { name: 'metaPixelId', label: 'Meta Pixel ID', type: 'TEXT', description: 'Facebook Meta Pixel ID for this offer (fires PageView + Lead where fbLead true)' },
  {
    name: 'status', label: 'Status', type: 'SELECT', description: 'DRAFT / ACTIVE / PAUSED',
    options: [
      { label: 'Draft', value: 'DRAFT', color: 'gray', position: 0 },
      { label: 'Active', value: 'ACTIVE', color: 'green', position: 1 },
      { label: 'Paused', value: 'PAUSED', color: 'yellow', position: 2 },
    ],
  },
  {
    name: 'ctaType', label: 'CTA Type', type: 'SELECT', description: 'CONSULTATION / PRICING / CUSTOM',
    options: [
      { label: 'Consultation', value: 'CONSULTATION', color: 'blue', position: 0 },
      { label: 'Pricing', value: 'PRICING', color: 'green', position: 1 },
      { label: 'Custom', value: 'CUSTOM', color: 'gray', position: 2 },
    ],
  },
];

const LEAD_FIELDS = [
  { name: 'contactName', label: 'Contact Name', type: 'TEXT', description: 'Lead contact name captured by the funnel' },
  { name: 'note', label: 'Note', type: 'TEXT', description: 'Contact details and quiz answers captured by the funnel' },
  { name: 'source', label: 'Source', type: 'TEXT', description: 'Lead source captured by the funnel' },
  {
    name: 'qualificationStatus', label: 'Qualification Status', type: 'SELECT', description: 'Qualified or disqualified from quiz',
    options: [
      { label: 'Qualified', value: 'QUALIFIED', color: 'green', position: 0 },
      { label: 'Disqualified', value: 'DISQUALIFIED', color: 'red', position: 1 },
    ],
  },
  {
    name: 'status', label: 'Status', type: 'SELECT', description: 'Mirrors qualification status',
    options: [
      { label: 'Qualified', value: 'QUALIFIED', color: 'green', position: 0 },
      { label: 'Lost', value: 'LOST', color: 'red', position: 1 },
    ],
  },
];

type ObjectDefinition = {
  singular: string;
  plural: string;
  labelSingular: string;
  labelPlural: string;
  description: string;
  fields: typeof CUSTOM_FIELDS;
};

async function ensureObject(definition: ObjectDefinition) {
  const objects = await listObjects();
  const existing = objects.find((o: any) => o.nameSingular === definition.singular);
  if (existing) {
    console.log(`✓ ${definition.plural} object already exists (${existing.id})`);
    return existing;
  }

  console.log(`Creating ${definition.plural} object via Metadata API...`);
  const res: any = await gql(
    `mutation CreateOneObjectMetadataItem($input: CreateOneObjectInput!) {
      createOneObject(input: $input) { id nameSingular namePlural }
    }`,
    {
      input: {
        object: {
          nameSingular: definition.singular,
          namePlural: definition.plural,
          labelSingular: definition.labelSingular,
          labelPlural: definition.labelPlural,
          description: definition.description,
        },
      },
    },
  );
  console.log('Created:', res.createOneObject);

  const refreshed = await listObjects();
  const created = refreshed.find((o: any) => o.nameSingular === definition.singular);
  if (!created) throw new Error(`${definition.singular} object missing after creation`);
  return created;
}

async function ensureField(objectId: string, field: any) {
  const res: any = await gql(
    `mutation CreateOneFieldMetadataItem($input: CreateOneFieldMetadataInput!) {
      createOneField(input: $input) { id name type }
    }`,
    {
      input: {
        field: {
          objectMetadataId: objectId,
          isActive: true,
          isNullable: true,
          isUnique: false,
          name: field.name,
          label: field.label,
          type: field.type,
          description: field.description,
          ...(field.options ? { options: field.options } : {}),
        },
      },
    },
  );
  console.log(`  + created field ${res.createOneField.name} (${res.createOneField.type})`);
}

async function main() {
  const definitions: ObjectDefinition[] = [
    {
      singular: 'agencyOffer', plural: 'agencyOffers', labelSingular: 'Agency Offer', labelPlural: 'Agency Offers',
      description: 'Offer funnels built by open-offer-builder (hero, quiz, thank-you, disqualified)', fields: CUSTOM_FIELDS,
    },
    {
      singular: 'agencyLead', plural: 'agencyLeads', labelSingular: 'Agency Lead', labelPlural: 'Agency Leads',
      description: 'Leads captured by open-offer-builder funnels', fields: LEAD_FIELDS,
    },
  ];

  for (const definition of definitions) {
    const obj = await ensureObject(definition);
    const existingFields = new Set((obj.fieldsList ?? []).map((f: any) => f.name));
    for (const field of definition.fields) {
      if (existingFields.has(field.name)) {
        console.log(`✓ ${definition.plural}.${field.name} already exists — skipping`);
        continue;
      }
      await ensureField(obj.id, field);
    }
  }

  console.log('✓ seed done — agencyOffers and agencyLeads ready');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
