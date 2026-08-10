// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/TridentCctpRouter.sol";

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    /// Set true to model a token whose permit reverts on a replayed nonce.
    bool public permitReverts;

    function setPermitReverts(bool v) external {
        permitReverts = v;
    }

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        require(allowance[f][msg.sender] >= v, "ERC20: transfer amount exceeds allowance");
        require(balanceOf[f] >= v, "ERC20: transfer amount exceeds balance");
        allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[t] += v;
        return true;
    }

    function permit(address owner, address spender, uint256 value, uint256, uint8, bytes32, bytes32)
        external
    {
        require(!permitReverts, "permit: invalid nonce");
        allowance[owner][spender] = value;
    }
}

/// @dev Records what CCTP was asked to do, and burns the tokens.
contract MockTokenMessenger is ITokenMessengerV2 {
    uint256 public amount;
    uint32 public destinationDomain;
    bytes32 public mintRecipient;
    address public burnToken;
    bytes32 public destinationCaller;
    uint256 public maxFee;
    uint32 public minFinalityThreshold;
    bytes public hookData;
    uint256 public calls;

    function depositForBurnWithHook(
        uint256 _amount,
        uint32 _destinationDomain,
        bytes32 _mintRecipient,
        address _burnToken,
        bytes32 _destinationCaller,
        uint256 _maxFee,
        uint32 _minFinalityThreshold,
        bytes calldata _hookData
    ) external override {
        MockUSDC(_burnToken).transferFrom(msg.sender, address(this), _amount);
        amount = _amount;
        destinationDomain = _destinationDomain;
        mintRecipient = _mintRecipient;
        burnToken = _burnToken;
        destinationCaller = _destinationCaller;
        maxFee = _maxFee;
        minFinalityThreshold = _minFinalityThreshold;
        hookData = _hookData;
        calls++;
    }
}

contract TridentCctpRouterTest is Test {
    MockUSDC usdc;
    MockTokenMessenger messenger;
    TridentCctpRouter router;

    address user = address(0xA11CE);
    address stranger = address(0xBAD);

    uint32 constant POLYGON_DOMAIN = 7;
    bytes32 constant RECIPIENT =
        bytes32(uint256(uint160(0x35D54B90D23b9e7bADcaC4864B22037D5D912a44)));
    bytes constant HOOK = hex"636374702d666f7277617264";

    function setUp() public {
        usdc = new MockUSDC();
        messenger = new MockTokenMessenger();
        router = new TridentCctpRouter(IERC20(address(usdc)), messenger);
        usdc.mint(user, 1_000_000);
    }

    /* ------------------------------------------------------------ the flow */

    function test_burnsCallersUsdcWithTheGivenDestination() public {
        vm.startPrank(user);
        usdc.approve(address(router), 30_000);
        router.bridge(POLYGON_DOMAIN, RECIPIENT, 30_000, 500, 1000, HOOK);
        vm.stopPrank();

        assertEq(messenger.calls(), 1);
        assertEq(messenger.amount(), 30_000);
        assertEq(messenger.destinationDomain(), POLYGON_DOMAIN);
        assertEq(messenger.mintRecipient(), RECIPIENT);
        assertEq(messenger.burnToken(), address(usdc));
        assertEq(messenger.maxFee(), 500);
        assertEq(usdc.balanceOf(user), 970_000, "debited exactly once");
    }

    /// The hook is passed through byte for byte. This contract must never
    /// reinterpret a format it cannot verify.
    function test_hookDataPassesThroughUnchanged() public {
        vm.startPrank(user);
        usdc.approve(address(router), 1_000);
        router.bridge(POLYGON_DOMAIN, RECIPIENT, 1_000, 10, 1000, HOOK);
        vm.stopPrank();
        assertEq(messenger.hookData(), HOOK);
    }

    /// No destination caller, so Circle's relayer can submit the mint and the
    /// user needs no gas on the far chain.
    function test_leavesDestinationCallerOpen() public {
        vm.startPrank(user);
        usdc.approve(address(router), 1_000);
        router.bridge(POLYGON_DOMAIN, RECIPIENT, 1_000, 10, 1000, HOOK);
        vm.stopPrank();
        assertEq(messenger.destinationCaller(), bytes32(0));
    }

    /// Any CCTP domain works without a code change — nothing is compiled in.
    function testFuzz_anyDestinationDomain(uint32 domain) public {
        vm.startPrank(user);
        usdc.approve(address(router), 1_000);
        router.bridge(domain, RECIPIENT, 1_000, 10, 1000, HOOK);
        vm.stopPrank();
        assertEq(messenger.destinationDomain(), domain);
    }

    /* --------------------------------------------------------- protections */

    /// The contract must never be a place funds can sit.
    function test_holdsNoBalanceAfterwards() public {
        vm.startPrank(user);
        usdc.approve(address(router), 30_000);
        router.bridge(POLYGON_DOMAIN, RECIPIENT, 30_000, 500, 1000, HOOK);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    /// It can only ever spend the caller's own USDC, never someone else's.
    function test_cannotSpendAnotherAccountsApproval() public {
        vm.prank(user);
        usdc.approve(address(router), 100_000);

        // The router pulls from msg.sender, so the stranger is stopped by their
        // own missing allowance — the victim's approval is never reachable.
        vm.prank(stranger);
        vm.expectRevert("ERC20: transfer amount exceeds allowance");
        router.bridge(POLYGON_DOMAIN, RECIPIENT, 50_000, 100, 1000, HOOK);

        assertEq(usdc.balanceOf(user), 1_000_000, "victim untouched");
        assertEq(usdc.allowance(user, address(router)), 100_000, "approval unspent");
        assertEq(messenger.calls(), 0, "no burn happened");
    }

    /// A fee that eats the whole transfer would mint nothing.
    function test_rejectsFeeAtOrAboveAmount() public {
        vm.startPrank(user);
        usdc.approve(address(router), 10_000);
        vm.expectRevert(TridentCctpRouter.FeeExceedsAmount.selector);
        router.bridge(POLYGON_DOMAIN, RECIPIENT, 1_000, 1_000, 1000, HOOK);
        vm.stopPrank();
    }

    function test_rejectsZeroRecipient() public {
        vm.startPrank(user);
        usdc.approve(address(router), 10_000);
        vm.expectRevert(TridentCctpRouter.ZeroRecipient.selector);
        router.bridge(POLYGON_DOMAIN, bytes32(0), 1_000, 10, 1000, HOOK);
        vm.stopPrank();
    }

    function test_rejectsZeroAmount() public {
        vm.prank(user);
        vm.expectRevert(TridentCctpRouter.ZeroAmount.selector);
        router.bridge(POLYGON_DOMAIN, RECIPIENT, 0, 0, 1000, HOOK);
    }

    /* -------------------------------------------------------------- permit */

    function test_permitRemovesTheSeparateApproval() public {
        vm.prank(user);
        router.bridgeWithPermit(
            POLYGON_DOMAIN, RECIPIENT, 25_000, 100, 1000, HOOK, block.timestamp + 1 hours, 27, 0, 0
        );

        assertEq(messenger.amount(), 25_000, "burned without a prior approve");
        assertEq(usdc.balanceOf(user), 975_000);
    }

    /// A front-run permit must not brick the call: the allowance it would have
    /// created already exists, so the burn should still go through.
    function test_frontRunPermitDoesNotBlockTheBridge() public {
        usdc.setPermitReverts(true);

        // Someone else already submitted the permit, so the allowance is set.
        vm.prank(user);
        usdc.approve(address(router), 25_000);

        vm.prank(user);
        router.bridgeWithPermit(
            POLYGON_DOMAIN, RECIPIENT, 25_000, 100, 1000, HOOK, block.timestamp + 1 hours, 27, 0, 0
        );

        assertEq(messenger.amount(), 25_000, "recovered from the replayed permit");
    }

    /// But a swallowed permit with no allowance behind it must still fail.
    function test_failedPermitWithNoAllowanceStillReverts() public {
        usdc.setPermitReverts(true);

        vm.prank(user);
        vm.expectRevert("ERC20: transfer amount exceeds allowance");
        router.bridgeWithPermit(
            POLYGON_DOMAIN, RECIPIENT, 25_000, 100, 1000, HOOK, block.timestamp + 1 hours, 27, 0, 0
        );
    }
}
