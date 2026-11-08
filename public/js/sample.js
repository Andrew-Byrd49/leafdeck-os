import { uid, addDays } from './util.js';

/** Realistic demo records spread around today's date. */
export function sampleData() {
  const id = () => uid();
  const d = addDays;

  const c = (name, company, type, email, phone, tags = '') => ({ id: id(), name, company, type, email, phone, tags });
  const contacts = [
    c('Maya Thompson', 'Brightline Studio', 'Client', 'maya@brightline.studio', '(919) 555-0142', 'retainer, web'),
    c('Jordan Ellis', 'Ellis & Park Law', 'Client', 'jordan@ellispark.law', '(919) 555-0178', 'branding'),
    c('Priya Shah', 'Oakridge Coffee Co.', 'Lead', 'priya@oakridgecoffee.com', '(984) 555-0110', 'ecommerce'),
    c('Sam Rivera', 'Rivera Builders', 'Lead', 'sam@riverabuilders.com', '(919) 555-0199', 'web'),
    c('Elena Cho', 'Northwind Health', 'Partner', 'elena@northwindhealth.org', '(919) 555-0123', 'referrals'),
    c('Chris Okafor', 'Pixel Forge', 'Vendor', 'chris@pixelforge.dev', '(704) 555-0155', 'contractor, dev'),
  ];
  const C = Object.fromEntries(contacts.map((x) => [x.name.split(' ')[0], x.id]));

  const t = (title, due, status, priority) => ({ id: id(), title, due, status, priority, ...(status === 'Done' ? { completedAt: Date.now() - 2 * 864e5 } : {}) });
  const tasks = [
    t('Finalize homepage wireframes', d(0), 'In Progress', 'High'),
    t('Write About page copy', d(3), 'To Do', 'Medium'),
    t('Set up staging on Cloudflare', d(-1), 'To Do', 'High'),
    t('Migrate blog posts', d(10), 'To Do', 'Low'),
    t('Present logo concepts', d(2), 'To Do', 'High'),
    t('Moodboard & references', d(-6), 'Done', 'Medium'),
    t('Send Oakridge proposal', d(1), 'To Do', 'High'),
    t('Quarterly estimated taxes', d(5), 'To Do', 'High'),
  ];

  const sp = (name, date, time, endTime) => ({ id: id(), name, date, time, endTime, status: 'Planned' });
  const sprints = [
    sp('Website push', d(0), '09:00', '10:30'),
    sp('Brand review prep', d(1), '10:00', '11:00'),
  ];
  Object.assign(tasks[0], { sprintId: sprints[0].id, tags: 'Important', url: 'https://www.figma.com' });
  Object.assign(tasks[2], { sprintId: sprints[0].id, tags: 'Urgent, Important', url: 'https://dash.cloudflare.com' });
  Object.assign(tasks[4], { sprintId: sprints[1].id, tags: 'Client' });
  Object.assign(tasks[6], { tags: 'Client, Important' });

  const events = [
    { id: id(), title: 'Brightline weekly check-in', date: d(0), time: '10:00', endTime: '10:30', location: 'Google Meet', contactId: C.Maya },
    { id: id(), title: 'Logo presentation — Ellis & Park', date: d(2), time: '14:00', endTime: '15:00', location: 'Their office', contactId: C.Jordan },
    { id: id(), title: 'Discovery call: Rivera Builders', date: d(1), time: '11:30', endTime: '12:00', location: 'Phone', contactId: C.Sam },
  ];

  const notes = [
    { id: id(), title: 'Pricing guidelines', body: 'Brand identity: $6k–$12k\nMarketing site: $8k–$18k\nRetainers: $1.5k–$4k / month\n\nAlways quote a discovery phase first.', pinned: true },
    { id: id(), title: 'Northwind call notes', body: 'Wants accessibility audit first. Decision maker is the COO. Budget approved for Q1.' },
  ];

  const L = (name, url, color, glyph, category) => ({ id: id(), name, url, color, glyph, category, desktop: true, embed: false });
  const links = [
    L('Gmail', 'https://mail.google.com', 'red', 'M', 'Email'),
    L('Google Drive', 'https://drive.google.com', 'yellow', 'D', 'Files'),
    L('GitHub', 'https://github.com', 'indigo', 'G', 'Dev'),
    L('Cloudflare', 'https://dash.cloudflare.com', 'orange', 'C', 'Dev'),
    L('Canva', 'https://www.canva.com', 'teal', 'Ca', 'Design'),
  ];

  return { contacts, tasks, sprints, events, notes, links };
}
