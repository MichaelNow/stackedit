import FileSaver from 'file-saver';
import TemplateWorker from 'worker-loader!./templateWorker.js'; // eslint-disable-line
import localDbSvc from './localDbSvc';
import markdownConversionSvc from './markdownConversionSvc';
import extensionSvc from './extensionSvc';
import utils from './utils';
import store from '../store';
import htmlSanitizer from '../libs/htmlSanitizer';

function groupHeadings(headings, level = 1) {
  const result = [];
  let currentItem;

  function pushCurrentItem() {
    if (currentItem) {
      if (currentItem.children.length > 0) {
        currentItem.children = groupHeadings(currentItem.children, level + 1);
      }
      result.push(currentItem);
    }
  }
  headings.forEach((heading) => {
    if (heading.level !== level) {
      currentItem = currentItem || {
        children: [],
      };
      currentItem.children.push(heading);
    } else {
      pushCurrentItem();
      currentItem = heading;
    }
  });
  pushCurrentItem();
  return result;
}

export default {
  /**
   * Apply the template to the file content
   */
  applyTemplate(fileId, template = {
    value: '{{{files.0.content.text}}}',
    helpers: '',
  }) {
    const file = store.state.file.itemMap[fileId];
    return localDbSvc.loadItem(`${fileId}/content`)
      .then((content) => {
        const properties = utils.computeProperties(content.properties);
        const options = extensionSvc.getOptions(properties);
        const converter = markdownConversionSvc.createConverter(options, true);
        const parsingCtx = markdownConversionSvc.parseSections(converter, content.text);
        const conversionCtx = markdownConversionSvc.convert(parsingCtx);
        const html = conversionCtx.htmlSectionList.map(htmlSanitizer.sanitizeHtml).join('');
        const elt = document.createElement('div');
        elt.innerHTML = html;

        // Unwrap tables
        elt.querySelectorAll('.table-wrapper').cl_each((wrapperElt) => {
          while (wrapperElt.firstChild) {
            wrapperElt.parentNode.appendChild(wrapperElt.firstChild);
          }
          wrapperElt.parentNode.removeChild(wrapperElt);
        });

        // Make TOC
        const headings = elt.querySelectorAll('h1,h2,h3,h4,h5,h6').cl_map(headingElt => ({
          title: headingElt.textContent,
          anchor: headingElt.id,
          level: parseInt(headingElt.tagName.slice(1), 10),
          children: [],
        }));
        const toc = groupHeadings(headings);
        const view = {
          files: [{
            name: file.name,
            content: {
              text: content.text,
              properties,
              yamlProperties: content.properties,
              html: elt.innerHTML,
              toc,
            },
          }],
        };

        // Run template conversion in a Worker to prevent attacks from helpers
        const worker = new TemplateWorker();
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            worker.terminate();
            reject('Template generation timeout.');
          }, 10000);
          worker.addEventListener('message', (e) => {
            clearTimeout(timeoutId);
            worker.terminate();
            // e.data can contain unsafe data if helpers attempts to call postMessage
            const [err, result] = e.data;
            if (err) {
              reject(`${err}`);
            } else {
              resolve(`${result}`);
            }
          });
          worker.postMessage([template.value, view, template.helpers]);
        });
      });
  },
  /**
   * Export a file to disk.
   */
  exportToDisk(fileId, type, template) {
    const file = store.state.file.itemMap[fileId];
    return this.applyTemplate(fileId, template)
      .then((res) => {
        const blob = new Blob([res], {
          type: 'text/plain;charset=utf-8',
        });
        FileSaver.saveAs(blob, `${file.name}.${type}`);
      });
  },
};
