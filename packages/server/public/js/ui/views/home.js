// Home: the inbox and the new-work box on one screen. What needs you is listed on top; the box to start the next piece
// of work sits at the bottom, where the reply box of a session is. Space and n open it with the box ready to type into;
// i opens it as it is.
import { $, el } from '../dom.js';
import { inboxList } from './inbox.js';
import { newWorkForm } from './new-work.js';

export function homeView() {
  const inbox = inboxList();
  const work = newWorkForm();
  const foot = el('div', { class: 's-foot' }, el('div', { class: 'inner' }, work.node));
  const screen = el('div', { class: 'session home' }, el('div', { class: 's-body' }, el('div', { class: 'inner' }, inbox.node)), foot);
  // The list scrolls under the foot: keep room for it at the end of the list, however tall the box grows.
  const room = new ResizeObserver(() => screen.style.setProperty('--foot-h', `${foot.offsetHeight}px`));
  room.observe(foot);
  $('main').replaceChildren(screen);
  return {
    key: 'inbox',
    update(r) {
      inbox.update();
      work.update();
      if (r?.write) {
        // "#/new" (Space, n, the rail's +, a work that could not be sent) is this screen with the box focused. Put the address
        // back to "#/" so that pressing n again is a change of address again.
        history.replaceState(null, '', '#/');
        work.focus();
      }
    },
  };
}
