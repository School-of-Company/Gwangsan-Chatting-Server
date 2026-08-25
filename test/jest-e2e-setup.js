const { File } = require('buffer');
if (typeof global.File === 'undefined') {
  global.File = File;
}
