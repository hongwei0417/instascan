const EventEmitter = require('events');
const ZXing = require('./zxing')(); // https://github.com/yushulx/zxing-cpp-emscripten
const Visibility = require('visibilityjs'); // 偵測網頁是否顯示狀態
const StateMachine = require('fsm-as-promised'); // 狀態機控管鏡頭啟用關閉狀態

class ScanProvider {
  constructor(emitter, analyzer, captureImage, scanPeriod, refractoryPeriod) {
    this.scanPeriod = scanPeriod; // 掃描間隔時間
    this.captureImage = captureImage; // 使否要擷取快照
    this.refractoryPeriod = refractoryPeriod;
    this._emitter = emitter;
    this._frameCount = 0; // 目前動畫更新次數
    this._analyzer = analyzer;
    this._lastResult = null;
    this._active = false;
  }

  start() {
    this._active = true;
    // 要求瀏覽器產生動畫
    // 每次產生動畫都呼叫掃描函式(this._scan())
    requestAnimationFrame(() => this._scan());
  }

  stop() {
    this._active = false;
  }

  scan() {
    return this._analyze(false); // 進行解析(強制取得結果)
  }

  // 取得掃描結果和快照
  _analyze(skipDups) {
    let analysis = this._analyzer.analyze();
    if (!analysis) {
      return null;
    }

    // 透過解析器取得結果(result)和影像(canvas)
    let { result, canvas } = analysis;
    if (!result) {
      return null;
    }

    // 防止照片重複更新
    if (skipDups && result === this._lastResult) {
      return null;
    }

    // 沒有反應時間就清空掃描結果(不太確定)
    clearTimeout(this.refractoryTimeout);
    this.refractoryTimeout = setTimeout(() => {
      this._lastResult = null;
    }, this.refractoryPeriod);

    // 如果開啟快照則透過canvas轉換為image
    let image = this.captureImage ? canvas.toDataURL('image/webp', 0.8) : null;

    this._lastResult = result;

    let payload = { content: result };
    if (image) {
      payload.image = image;
    }

    return payload;
  }

  _scan() {
    if (!this._active) {
      return;
    }

    requestAnimationFrame(() => this._scan()); //透過遞迴呼叫不斷更新動畫

    // 若未達到掃描間格時間(scanPeriod)，則不會進行掃描
    if (++this._frameCount !== this.scanPeriod) {
      return;
    } else {
      this._frameCount = 0;
    }

    let result = this._analyze(true); //進行掃描(忽略重複結果)
    if (result) {
      // 非同步觸發scan事件，並傳送結果內容和圖片
      setTimeout(() => {
        this._emitter.emit('scan', result.content, result.image || null);
      }, 0);
    }
  }
}

class Analyzer {
  constructor(video) {
    this.video = video;

    this.imageBuffer = null;
    this.sensorLeft = null;
    this.sensorTop = null;
    this.sensorWidth = null;
    this.sensorHeight = null;

    this.canvas = document.createElement('canvas'); // 創建canvas來渲染圖片
    this.canvas.style.display = 'none';
    this.canvasContext = null;

    // 他使用這個人的開源: https://github.com/yushulx/zxing-cpp-emscripten
    // 定義解析的 callback 處理邏輯
    this.decodeCallback = ZXing.Runtime.addFunction(function (ptr, len, resultIndex, resultCount) {
      let result = new Uint8Array(ZXing.HEAPU8.buffer, ptr, len);
      let str = String.fromCharCode.apply(null, result);
      if (resultIndex === 0) {
        window.zxDecodeResult = '';
      }
      window.zxDecodeResult += str; //解析組成字串
    });
  }

  analyze() {
    if (!this.video.videoWidth) {
      return null;
    }

    if (!this.imageBuffer) {
      let videoWidth = this.video.videoWidth;
      let videoHeight = this.video.videoHeight;

      // 設定置中位置
      this.sensorWidth = videoWidth;
      this.sensorHeight = videoHeight;
      this.sensorLeft = Math.floor((videoWidth / 2) - (this.sensorWidth / 2));
      this.sensorTop = Math.floor((videoHeight / 2) - (this.sensorHeight / 2));

      this.canvas.width = this.sensorWidth;
      this.canvas.height = this.sensorHeight;

      this.canvasContext = this.canvas.getContext('2d');
      this.imageBuffer = ZXing._resize(this.sensorWidth, this.sensorHeight);
      return null;
    }

    // 渲染影片和設定長寬位置
    this.canvasContext.drawImage(
      this.video,
      this.sensorLeft,
      this.sensorTop,
      this.sensorWidth,
      this.sensorHeight
    );

    // read barcode...
    let data = this.canvasContext.getImageData(0, 0, this.sensorWidth, this.sensorHeight).data;
    // start decode barcode...
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      let [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      ZXing.HEAPU8[this.imageBuffer + j] = Math.trunc((r + g + b) / 3); //將結果存進HEAP
    }

    // 解析 QR Code
    let err = ZXing._decode_qr(this.decodeCallback); 
    if (err) {
      return null;
    }

    let result = window.zxDecodeResult;
    if (result != null) {
      return { result: result, canvas: this.canvas }; //將結果和影像回傳
    }

    return null;
  }
}

class Scanner extends EventEmitter {
  constructor(opts) {
    super();

    this.video = this._configureVideo(opts); // 取得 video DOM
    this.mirror = (opts.mirror !== false); // 是否要鏡像
    this.backgroundScan = (opts.backgroundScan !== false); // 是否開啟鏡頭
    this._continuous = (opts.continuous !== false); // 是否持續掃描
    this._analyzer = new Analyzer(this.video); // 取得解析器
    this._camera = null; // 目前鏡頭

    let captureImage = opts.captureImage || false; // 是否擷取圖片
    let scanPeriod = opts.scanPeriod || 1; // 掃描的間隔
    let refractoryPeriod = opts.refractoryPeriod || (5 * 1000); // 沒有反應的間隔

    this._scanner = new ScanProvider(this, this._analyzer, captureImage, scanPeriod, refractoryPeriod); // 取得掃描器
    this._fsm = this._createStateMachine(); //創建狀態機

    // 偵測網頁顯示狀態
    Visibility.change((e, state) => {
      if (state === 'visible') {
        setTimeout(() => {
          if (this._fsm.can('activate')) {
            this._fsm.activate();
          }
        }, 0);
      } else {
        if (!this.backgroundScan && this._fsm.can('deactivate')) {
          this._fsm.deactivate();
        }
      }
    });

    // 切換 video 啟用狀態
    this.addListener('active', () => {
      this.video.classList.remove('inactive');
      this.video.classList.add('active');
    });

    this.addListener('inactive', () => {
      this.video.classList.remove('active');
      this.video.classList.add('inactive');
    });

    this.emit('inactive');
  }

  scan() {
    return this._scanner.scan();
  }

  async start(camera = null) {
    if (this._fsm.can('start')) {
      await this._fsm.start(camera);
    } else {
      await this._fsm.stop();
      await this._fsm.start(camera);
    }
  }

  async stop() {
    if (this._fsm.can('stop')) {
      await this._fsm.stop();
    }
  }

  set captureImage(capture) {
    this._scanner.captureImage = capture;
  }

  get captureImage() {
    return this._scanner.captureImage;
  }

  set scanPeriod(period) {
    this._scanner.scanPeriod = period;
  }

  get scanPeriod() {
    return this._scanner.scanPeriod;
  }

  set refractoryPeriod(period) {
    this._scanner.refractoryPeriod = period;
  }

  get refractoryPeriod() {
    return this._scanner.refractoryPeriod;
  }

  set continuous(continuous) {
    this._continuous = continuous;

    if (continuous && this._fsm.current === 'active') {
      this._scanner.start();
    } else {
      this._scanner.stop();
    }
  }

  get continuous() {
    return this._continuous;
  }

  set mirror(mirror) {
    this._mirror = mirror;

    if (mirror) {
      this.video.style.MozTransform = 'scaleX(-1)';
      this.video.style.webkitTransform = 'scaleX(-1)';
      this.video.style.OTransform = 'scaleX(-1)';
      this.video.style.msFilter = 'FlipH';
      this.video.style.filter = 'FlipH';
      this.video.style.transform = 'scaleX(-1)';
    } else {
      this.video.style.MozTransform = null;
      this.video.style.webkitTransform = null;
      this.video.style.OTransform = null;
      this.video.style.msFilter = null;
      this.video.style.filter = null;
      this.video.style.transform = null;
    }
  }

  get mirror() {
    return this._mirror;
  }

  async _enableScan(camera) {
    this._camera = camera || this._camera;
    if (!this._camera) {
      throw new Error('Camera is not defined.');
    }

    let stream = await this._camera.start(); // 要求存取並取得串流
    this.video.srcObject = stream; // 將串流加入 video

    if (this._continuous) {
      this._scanner.start();
    }
  }

  _disableScan() {
    this.video.src = '';

    if (this._scanner) {
      this._scanner.stop();
    }

    if (this._camera) {
      this._camera.stop();
    }
  }

  _configureVideo(opts) {
    if (opts.video) {
      if (opts.video.tagName !== 'VIDEO') {
        throw new Error('Video must be a <video> element.');
      }
    }

    // 創建 video dom
    let video = opts.video || document.createElement('video');
    video.setAttribute('autoplay', 'autoplay');

    return video;
  }

  _createStateMachine() {
    return StateMachine.create({
      initial: 'stopped',
      events: [
        {
          name: 'start',
          from: 'stopped',
          to: 'started'
        },
        {
          name: 'stop',
          from: ['started', 'active', 'inactive'],
          to: 'stopped'
        },
        {
          name: 'activate',
          from: ['started', 'inactive'],
          to: ['active', 'inactive'],
          condition: function (options) {
            if (Visibility.state() === 'visible' || this.backgroundScan) {
              return 'active';
            } else {
              return 'inactive';
            }
          }
        },
        {
          name: 'deactivate',
          from: ['started', 'active'],
          to: 'inactive'
        }
      ],
      callbacks: {
        // 每次鏡頭啟用就開始掃描，並觸active事件
        onenteractive: async (options) => {
          await this._enableScan(options.args[0]);
          this.emit('active');
        },
        // 每次鏡頭啟用就開始掃描，並觸active事件
        onleaveactive: () => {
          this._disableScan();
          this.emit('inactive');
        },
        // 進入started時(呼叫start())，呼叫activate()並送入鏡頭實體
        onenteredstarted: async (options) => {
          await this._fsm.activate(options.args[0]);
        }
      }
    });
  }
}

module.exports = Scanner;
