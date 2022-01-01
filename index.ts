import { BigNumber } from "bignumber.js";
import { ethers } from "ethers";
import * as erc20Abi from "./erc20Abi.json";
import * as uniNftAbi from "./uniNftAbi.json";
import * as uniRouterAbi from "./uniRouterAbi.json";

import { nearestUsableTick } from '@uniswap/v3-sdk/'
import { abi as IUniswapV3PoolABI } from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json";
import { Token } from "@uniswap/sdk-core";


class PoolImmutables {
  poolContract:ethers.Contract;

  factory:string;
  token0:string;
  token1:string;
  fee:number;
  tickSpacing:number;
  maxLiquidityPerTick:ethers.BigNumber;

  constructor(poolContract:ethers.Contract) {
    this.poolContract = poolContract;
  }

  public async updatePoolImmutables():Promise<void> {
    this.factory = await this.poolContract.factory();
    this.token0 = await this.poolContract.token0();
    this.token1 = await this.poolContract.token1();
    this.fee = await this.poolContract.fee();
    this.tickSpacing = await this.poolContract.tickSpacing();
    this.maxLiquidityPerTick = await this.poolContract.maxLiquidityPerTick();
  }

  public print() {
    console.log("POOL IMMUTABLES:");
    console.log("factory: ", this.factory);
    console.log("token0: ", this.token0);
    console.log("token1: ", this.token1);
    console.log("fee: ", this.fee);
    console.log("tickSpacing: ", this.tickSpacing);
    console.log("maxLiquidityPerTick: ", this.maxLiquidityPerTick.toString());
  }
}

class PoolState {
  poolContract:ethers.Contract;

  liquidity:ethers.BigNumber;
  sqrtPriceX96:ethers.BigNumber;
  tick:number;
  observationIndex:number;
  observationCardinality:number;
  observationCardinalityNext:number;
  feeProtocol:number;
  unlocked:number;

  constructor(poolContract:ethers.Contract) {
    this.poolContract = poolContract;
  }

  public async updatePoolState():Promise<void> {
    const slot = await this.poolContract.slot0();
    this.liquidity = await this.poolContract.liquidity();
    this.sqrtPriceX96 = slot[0];
    this.tick = slot[1];
    this.observationIndex = slot[2];
    this.observationCardinality = slot[3];
    this.observationCardinalityNext = slot[4];
    this.feeProtocol = slot[5];
    this.unlocked = slot[6];
  }

  public print() {
    console.log("POOL STATE:");
    console.log("liquidity: ", this.liquidity.toString());
    console.log("sqrtPriceX96: ", this.sqrtPriceX96.toString());
    console.log("tick:", this.tick);
    console.log("observationIndex: ", this.observationIndex);
    console.log("observationCardinality: ", this.observationCardinality);
    console.log("observationCardinalityNext: ", this.observationCardinalityNext);
    console.log("feeProtocol: ", this.feeProtocol);
    console.log("unlocked: ", this.unlocked);
  }
}

class umr {
  wallet:ethers.Wallet;
  provider:ethers.providers.JsonRpcProvider;
  chainId:number;

  nftId:number = -1;
  uniNftContract:ethers.Contract;
  poolContract:ethers.Contract;
  myPoolImmutables:PoolImmutables;
  myPoolState:PoolState;
  uniToken0:Token;
  uniToken1:Token;
  erc20Token0:ethers.Contract;
  erc20Token1:ethers.Contract;
  lowerTick:number = 0;
  upperTick:number = 0;
  maxRatioDeviation:number;
  maxSlippage:BigNumber;
  uniRouter:ethers.Contract;
  currentlyRunning:boolean = false;
  maxDelaySeconds:number = 60; // for uniswap transactions to time out, in seconds
  tickCountPerSide:number = 2; // for positions to open, ticks on each side of the current tick

  constructor(
    chainId:number,
    privateKey:string,
    rpcProvider:string,
    uniNft:string,
    uniPool:string,
    uniRouterAddress:string,
    maxRatioDeviation:number,
    maxSlippage:number
  ) {
    this.chainId = chainId;
    this.provider = new ethers.providers.JsonRpcProvider(rpcProvider);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.maxRatioDeviation = maxRatioDeviation; // 0.2 = ratio of token0 and token1 values has to be between 0.2 and 5, otherwise will trade to 1:1
    this.maxSlippage = new BigNumber(maxSlippage); // 0.01 = 1% max slippage
    this.poolContract = new ethers.Contract(
      uniPool,
      IUniswapV3PoolABI,
      this.provider
    );
    this.uniNftContract = new ethers.Contract(
      uniNft,
      uniNftAbi,
      this.provider
    );
    this.myPoolImmutables = new PoolImmutables(this.poolContract);
    this.myPoolState = new PoolState(this.poolContract);
    this.uniRouter = new ethers.Contract(
      uniRouterAddress,
      uniRouterAbi,
      this.provider
    );
  }

  public async init():Promise<void> {
    this.currentlyRunning = true;
    await this.myPoolImmutables.updatePoolImmutables();
    await this.myPoolState.updatePoolState();
    this.erc20Token0 = new ethers.Contract(
      this.myPoolImmutables.token0,
      erc20Abi,
      this.provider
    );
    this.erc20Token1 = new ethers.Contract(
      this.myPoolImmutables.token1,
      erc20Abi,
      this.provider
    );
    this.uniToken0 = new Token(
      this.chainId,
      this.myPoolImmutables.token0,
      await this.erc20Token0.decimals(),
      await this.erc20Token0.name(),
      await this.erc20Token0.symbol()
    );
    this.uniToken1 = new Token(
      this.chainId,
      this.myPoolImmutables.token1,
      await this.erc20Token1.decimals(),
      await this.erc20Token1.name(),
      await this.erc20Token1.symbol()
    );
    this.currentlyRunning = false;
  }

  public async updateBalance():Promise<void> {
    var balance0 = new BigNumber((await this.erc20Token0.balanceOf(this.wallet.address)).toString());
    var balance1 = new BigNumber((await this.erc20Token1.balanceOf(this.wallet.address)).toString());

    console.log(balance1.toString());
    var sqrtPriceX96 = new BigNumber(this.myPoolState.sqrtPriceX96.toString())
    var price = (sqrtPriceX96.pow(2)).div(new BigNumber(2).pow(192))
    var valueBalance0 = balance0.times(price);
    console.log("value of balance0: ", valueBalance0.toString());
    var ratio = valueBalance0.div(balance1);
    console.log("ratio: ", ratio.toNumber());
  
    if (ratio.toNumber() < this.maxRatioDeviation || ratio.toNumber() > 1 / this.maxRatioDeviation) {
      var sellValue0 = valueBalance0.minus(balance1).div(new BigNumber(2));
      console.log("ratio too far off, need to sell ", sellValue0.toString(), " worth of token0");
      var sellAmount0 = sellValue0.div(price);
      console.log("that is ", sellAmount0.toString(), " of token0");

      if (sellValue0.isNegative()) {
        var minAmount0 = sellAmount0.abs().times((new BigNumber(1)).minus(this.maxSlippage));
        console.log("after slippage that should be minimally ", minAmount0.toString());
        console.log("buying this amount");
        var treq = await this.uniRouter.populateTransaction.exactInputSingle([
          this.myPoolImmutables.token1,
          this.myPoolImmutables.token0,
          this.myPoolImmutables.fee,
          this.wallet.address,
          sellValue0.abs().decimalPlaces(0).toString(),
          minAmount0.decimalPlaces(0).toString(),
          0
        ]);
      }
      else {
        var minAmount1 = sellValue0.abs().times((new BigNumber(1)).minus(this.maxSlippage));
        console.log("after slippage that should be minimally ", minAmount1.toString());
        console.log("selling this amout");
        var treq = await this.uniRouter.populateTransaction.exactInputSingle([
          this.myPoolImmutables.token0,
          this.myPoolImmutables.token1,
          this.myPoolImmutables.fee,
          this.wallet.address,
          sellAmount0.abs().decimalPlaces(0).toString(),
          minAmount1.decimalPlaces(0).toString(),
          0
        ]);
      }
      await this.sendTx(treq);
    }
  }

  public async collectFees(nftId:number):Promise<string> {
    let tx = await this.uniNftContract.populateTransaction.collect([
      nftId,
      this.wallet.address,
      "340282366920938463463374607431768211455",
      "340282366920938463463374607431768211455"
    ]);
    console.log("closing tx: ", tx);
    return tx.data;
  }

  public async withdrawLiquidity(nftId:number):Promise<string> {
    const maxDelaySeconds = 1800;

    let position = await this.uniNftContract.positions(nftId);
    console.log("position to withdraw: ", position);
    const deadline = Math.floor(new Date().getTime()/1000) + maxDelaySeconds;

    let tx = await this.uniNftContract.populateTransaction.decreaseLiquidity([
      nftId,
      position[7],
      0,
      0,
      deadline
    ]);
    console.log("withdraw tx: ", tx);
    return tx.data;
  }

  public async withdrawAndCollect(nftId:number):Promise<void> {
    let withdrawTx = await this.withdrawLiquidity(nftId);
    let collectTx = await this.collectFees(nftId);
    let treq = await this.uniNftContract.populateTransaction.multicall([
      withdrawTx,
      collectTx
    ]);
    console.log("withdraw and collect multicall tx: ", treq);
    await this.sendTx(treq);
    this.nftId = -1; // reset NFT id so that we can know when to open a new position
  }

  public async openPosition():Promise<void> {
    await this.myPoolState.updatePoolState();
    const deadline = Math.floor(new Date().getTime()/1000) + this.maxDelaySeconds;
    let nearestTick = nearestUsableTick(this.myPoolState.tick, this.myPoolImmutables.tickSpacing);
    this.upperTick = nearestTick + this.myPoolImmutables.tickSpacing * this.tickCountPerSide;
    this.lowerTick = nearestTick - this.myPoolImmutables.tickSpacing * this.tickCountPerSide;

    // all-in, yolo, LFG!!!
    let token0Balance = await this.erc20Token0.balanceOf(this.wallet.address);
    let token1Balance = await this.erc20Token1.balanceOf(this.wallet.address);
    console.log("LPing all-in: ", token0Balance.toString(), ", ", token1Balance.toString());

    let treq = await this.uniNftContract.populateTransaction.mint([
      this.myPoolImmutables.token0,
      this.myPoolImmutables.token1,
      this.myPoolImmutables.fee,
      this.lowerTick,
      this.upperTick,
      token0Balance,
      token1Balance,
      0, 0, this.wallet.address, deadline
    ]);

    var receipt = await this.sendTx(treq);
    this.nftId = parseInt(receipt.logs[6].topics[1]);

    console.log("minted NFT id: ", this.nftId);
  }

  public async doNextAction() {
    if (this.currentlyRunning) {
      console.log("currently running, skipping tick...");
      return;
    }
    this.currentlyRunning = true;
    let startTime = new Date().getTime();
    await this.myPoolState.updatePoolState(); // to get latest price info
    // check if there's anything to do:
    // if position is out of range, close it
    console.log("NFT id: ", this.nftId);
    console.log("pool tick: ", this.myPoolState.tick);
    console.log("upper tick: ", this.upperTick);
    console.log("lower tick: ", this.lowerTick);
    if (this.nftId > -1 && (this.myPoolState.tick < this.lowerTick || this.myPoolState.tick > this.upperTick)) {
      console.log("Out of range, closing position");
      await this.withdrawAndCollect(this.nftId);
    }
    if (this.nftId == -1) {
      console.log("there is no position, checking balances");
      await this.updateBalance();
      console.log("opening position");
      await this.openPosition();
    }
    console.log("DONE checking next action");
    this.currentlyRunning = false;
    let endTime = new Date().getTime();
    console.log("Tick took ", (endTime - startTime)/1000, " s");
  }
  
  public async sendTx(treq:ethers.providers.TransactionRequest):Promise<ethers.providers.TransactionReceipt> {
    console.log("Transaction Request: ", treq);
    var tres = await this.wallet.sendTransaction(treq);
    console.log("Transaction Response: ", tres);
    var trec = await tres.wait()
    console.log("Transaction Receipt: ", trec);
    return trec;
  }

  public async tick():Promise<void> {
    // make sure appropriate approvals have been set (for both swapping and LPing for both tokens)
    // check where current price is wrt existing position
    // if position off by more than 1 tick, close position
    // if no position open, open new position:
    //   if more than 50% out of balance, swap tokens to re-balance
    //   open new position
    await this.openPosition();
  }
}

async function main(privateKey:string) {
  const tickIntervalMs = 60000;
  var rpcProvider = "https://arb1.arbitrum.io/rpc";
  const uniNft = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"; // on Arbitrum
  const uniPool = "0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443" // WETH-USDC 0.05% on Arbitrum
  const uniRouter = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" // on Arbitrum 
  const chainId = 42161;
  const maxRatioDeviation = 0.3; // 0.2 = ratio of token0 and token1 values has to be between 0.2 and 5, otherwise will trade to 1:1
  const maxSlippage = 0.01; // 0.01 = 1% max slippage
  var myUmr = new umr(chainId, privateKey, rpcProvider, uniNft, uniPool, uniRouter, maxRatioDeviation, maxSlippage);

  await myUmr.init();
  myUmr.myPoolImmutables.print();
  myUmr.myPoolState.print();
  myUmr.doNextAction();
  setInterval(() => { myUmr.doNextAction(); }, tickIntervalMs);
}

const myArgs = process.argv.slice(2);
if (myArgs.length != 1) {
  console.log("expected private key as only parameter");
  process.exit();
}
const privateKey = myArgs[0];
main(privateKey);
